// Where each runner keeps its config, what setup touches there, and the runner's own plugin
// commands. The runner homes honour CLAUDE_CONFIG_DIR and CODEX_HOME, so tests and checks can use
// scratch homes; the runner binaries can be swapped with CONTEXT_ENGINE_CLAUDE_BIN/_CODEX_BIN.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { absoluteName, anchor, childTarget, closeSync, fstatSync, lstatSync, mkdirPrivateSync, openSync, realpathSync, writeFileSync } from '../core/platform.ts';
import { openPrivateDirectory, resolveStateRoot } from '../core/store.ts';
import type { Rule } from './ledger.ts';
import { jsonRule, tomlTablesRule } from './rules.ts';

export interface SetupContext {
  env: NodeJS.ProcessEnv;
  /** This checkout: the Claude plugins are read from it, and the Codex hooks call its CLI. */
  checkout: string;
  setupDir: string;
  claudeHome: string;
  codexHome: string;
}

export function setupContext(env: NodeJS.ProcessEnv = process.env): SetupContext {
  const home = env.HOME || homedir();
  return {
    env,
    checkout: fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, ''),
    setupDir: join(resolveStateRoot(undefined, env), 'setup'),
    claudeHome: resolve(env.CLAUDE_CONFIG_DIR || join(home, '.claude')),
    codexHome: resolve(env.CODEX_HOME || join(home, '.codex')),
  };
}

export const MARKETPLACE = 'context-engine';
export const CLAUDE_PLUGIN_IDS = [`context-engine@${MARKETPLACE}`, `context-engine-trigger@${MARKETPLACE}`] as const;
export const CODEX_PLUGIN_ID = `context-engine@${MARKETPLACE}`;
/** The five hooks of adapters/codex/plugin/hooks/hooks.json, as Codex keys their trust. */
export const CODEX_HOOK_COUNT = 5;

export interface RunnerSpec {
  id: 'claude' | 'codex';
  title: string;
  home: string;
  bin: string;
  /** Config files the runner's plugin commands change: backed up byte for byte first. */
  files: string[];
  /** Directories where the runner creates files during install. */
  watch: string[];
  /** Directories that are ours by name (plugin caches, staged copies). */
  namespaced: string[];
  rules: Record<string, Rule>;
  install: string[][];
  uninstall: string[][];
  /** Runs after the backup, before the runner's commands. */
  prepare?: () => void;
}

/** The Codex plugin is copied into Codex's cache, so it is staged with the CLI path baked into its hook command. */
export function stagedCodexMarketplace(ctx: SetupContext): string {
  return join(ctx.setupDir, 'codex-marketplace');
}

const shellQuote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

export function stageCodexPlugin(ctx: SetupContext): void {
  // The delete goes through the verified setup directory's descriptor. Every later write goes through
  // descriptors of directories staging itself created, so no name swapped for a link can redirect it.
  const setup = openPrivateDirectory(ctx.setupDir, { create: true })!;
  try {
    const staged = childTarget(anchor(setup), 'codex-marketplace');
    rmSync(absoluteName(staged), { recursive: true, force: true });
    const root = makeDirectory(setup, 'codex-marketplace', stagedCodexMarketplace(ctx));
    try {
      stageThrough(ctx, root);
      // The runner reads the staged plugin by name, so the name must still be the directory written here.
      const now = lstatSync(staged), opened = fstatSync(root);
      if (now.dev !== opened.dev || now.ino !== opened.ino) throw new Error(`the staged Codex plugin directory changed while it was written: ${stagedCodexMarketplace(ctx)}. Install refused.`);
    } finally { closeSync(root); }
    if (realpathSync(anchor(setup)) !== resolve(ctx.setupDir)) throw new Error('setup directory changed while the Codex plugin was staged. Install refused.');
  } finally { closeSync(setup); }
}

/** Creates a private directory through its parent's descriptor and opens it without following a link. */
function makeDirectory(parent: number, name: string, shown: string): number {
  const target = childTarget(anchor(parent), name);
  try { mkdirPrivateSync(target); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`setup refuses a staging path that appeared while the Codex plugin was staged: ${shown}`);
    throw e;
  }
  return openSync(target, 'directory');
}

/** Writes a new file through its parent's descriptor. An existing name, link or not, refuses. */
function writeNew(parent: number, name: string, bytes: string | Uint8Array): void {
  const fd = openSync(childTarget(anchor(parent), name), 'exclusive-nofollow');
  try { writeFileSync(fd, bytes); } finally { closeSync(fd); }
}

/** Copies a source tree of plain directories and files into an open directory. */
function copyTree(source: string, parent: number, shown: string, edit: (path: string, bytes: Buffer) => string | Uint8Array): void {
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name), to = join(shown, entry.name);
    if (entry.isDirectory()) {
      const child = makeDirectory(parent, entry.name, to);
      try { copyTree(from, child, to, edit); } finally { closeSync(child); }
    } else if (entry.isFile()) writeNew(parent, entry.name, edit(from, readFileSync(from)));
    else throw new Error(`unexpected entry in the Codex plugin source; staging refused: ${from}`);
  }
}

function stageThrough(ctx: SetupContext, root: number): void {
  const source = join(ctx.checkout, 'adapters', 'codex', 'plugin');
  const shown = stagedCodexMarketplace(ctx);
  const cli = join(ctx.checkout, 'core', 'cli.ts');
  const withHookCommands = (path: string, bytes: Buffer): string | Uint8Array => {
    if (path !== join(source, 'hooks', 'hooks.json')) return bytes;
    const hooks = JSON.parse(bytes.toString('utf8'));
    for (const groups of Object.values(hooks.hooks) as Array<Array<{ hooks: Array<{ command: string }> }>>) {
      for (const group of groups) for (const hook of group.hooks) {
        if (!hook.command.startsWith('node ')) throw new Error('unexpected Context Engine hook command; staging refused');
        hook.command = `CONTEXT_ENGINE_CLI=${shellQuote(cli)} ${shellQuote(process.execPath)} ${hook.command.slice(5)}`;
      }
    }
    return `${JSON.stringify(hooks, null, 2)}\n`;
  };
  const plugins = makeDirectory(root, 'plugins', join(shown, 'plugins'));
  try {
    const plugin = makeDirectory(plugins, 'context-engine', join(shown, 'plugins', 'context-engine'));
    try { copyTree(source, plugin, join(shown, 'plugins', 'context-engine'), withHookCommands); } finally { closeSync(plugin); }
  } finally { closeSync(plugins); }
  const agents = makeDirectory(root, '.agents', join(shown, '.agents'));
  try {
    const marketplace = makeDirectory(agents, 'plugins', join(shown, '.agents', 'plugins'));
    try {
      writeNew(marketplace, 'marketplace.json', `${JSON.stringify({ name: MARKETPLACE, plugins: [{ name: 'context-engine', source: { source: 'local', path: './plugins/context-engine' } }] }, null, 2)}\n`);
    } finally { closeSync(marketplace); }
  } finally { closeSync(agents); }
}

export const CODEX_OUR_TABLES = /^\[(marketplaces\.context-engine|plugins\."context-engine@context-engine"|hooks\.state\."context-engine@context-engine:[^"]*")\]$/;

export function codexSpec(ctx: SetupContext): RunnerSpec {
  const h = ctx.codexHome;
  const config = join(h, 'config.toml');
  return {
    id: 'codex',
    title: 'Codex',
    home: h,
    bin: ctx.env.CONTEXT_ENGINE_CODEX_BIN || 'codex',
    files: [config],
    watch: [join(h, 'plugins'), join(h, '.tmp')],
    namespaced: [join(h, 'plugins', 'cache', MARKETPLACE), join(h, 'plugins', 'data', CODEX_PLUGIN_ID.replace('@', '-')), stagedCodexMarketplace(ctx)],
    rules: { [config]: tomlTablesRule(CODEX_OUR_TABLES, /^\[(hooks|hooks\.state|marketplaces|plugins)\]$/, (key, body) => {
      // The exact tables this install writes, so a file without its before copy loses only those. Hook trust
      // tables hold hashes that setup cannot recompute here, so they stay and are listed.
      const lines = body.map((line) => line.trim()).filter((line) => line !== '');
      if (key.length === 2 && key[0] === 'plugins' && key[1] === CODEX_PLUGIN_ID) return lines.length === 1 && lines[0] === 'enabled = true';
      if (key.length === 2 && key[0] === 'marketplaces' && key[1] === MARKETPLACE) return lines.length === 2 && lines[0] === 'source_type = "local"' && lines[1] === `source = ${JSON.stringify(stagedCodexMarketplace(ctx))}`;
      return false;
    }) },
    install: [
      ['plugin', 'marketplace', 'add', stagedCodexMarketplace(ctx)],
      ['plugin', 'add', CODEX_PLUGIN_ID],
    ],
    uninstall: [
      ['plugin', 'remove', CODEX_PLUGIN_ID],
      ['plugin', 'marketplace', 'remove', MARKETPLACE],
    ],
    prepare: () => stageCodexPlugin(ctx),
  };
}

/** Runs a runner binary (a .ts/.js path runs with node, for test doubles). */
export function runBinary(bin: string, args: string[], env: NodeJS.ProcessEnv, opts: { cwd?: string; timeoutMs?: number } = {}): { ok: boolean; output: string; stdout: string } {
  const [file, argv] = /\.[cm]?[jt]s$/.test(bin) ? [process.execPath, [bin, ...args]] : [bin, args];
  const r = spawnSync(file, argv, { env, encoding: 'utf8', timeout: opts.timeoutMs ?? 120_000, cwd: opts.cwd, maxBuffer: 16 << 20 });
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  if (r.error) return { ok: false, output: r.error.message, stdout: '' };
  return { ok: r.status === 0, output, stdout: r.stdout ?? '' };
}
