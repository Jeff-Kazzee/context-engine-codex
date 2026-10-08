// Where each runner keeps its config, what setup touches there, and the runner's own plugin
// commands. The runner homes honour CLAUDE_CONFIG_DIR and CODEX_HOME, so tests and checks can use
// scratch homes; the runner binaries can be swapped with CONTEXT_ENGINE_CLAUDE_BIN/_CODEX_BIN.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveStateRoot } from '../core/store.ts';
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
  const root = stagedCodexMarketplace(ctx);
  rmSync(root, { recursive: true, force: true });
  const plugin = join(root, 'plugins', 'context-engine');
  cpSync(join(ctx.checkout, 'adapters', 'codex', 'plugin'), plugin, { recursive: true });
  const hooksPath = join(plugin, 'hooks', 'hooks.json');
  const cli = join(ctx.checkout, 'core', 'cli.ts');
  const hooks = JSON.parse(readFileSync(hooksPath, 'utf8'));
  for (const groups of Object.values(hooks.hooks) as Array<Array<{ hooks: Array<{ command: string }> }>>) {
    for (const group of groups) for (const hook of group.hooks) {
      if (!hook.command.startsWith('node ')) throw new Error('unexpected Context Engine hook command; staging refused');
      hook.command = `CONTEXT_ENGINE_CLI=${shellQuote(cli)} ${shellQuote(process.execPath)} ${hook.command.slice(5)}`;
    }
  }
  writeFileSync(hooksPath, `${JSON.stringify(hooks, null, 2)}\n`);
  mkdirSync(join(root, '.agents', 'plugins'), { recursive: true });
  writeFileSync(
    join(root, '.agents', 'plugins', 'marketplace.json'),
    `${JSON.stringify({ name: MARKETPLACE, plugins: [{ name: 'context-engine', source: { source: 'local', path: './plugins/context-engine' } }] }, null, 2)}\n`,
  );
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
    rules: { [config]: tomlTablesRule(CODEX_OUR_TABLES, /^\[(hooks|hooks\.state|marketplaces|plugins)\]$/) },
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
