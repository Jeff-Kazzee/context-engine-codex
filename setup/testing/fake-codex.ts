#!/usr/bin/env node
// Test double for `codex plugin ...` (codex-cli 0.160.0), with the side effects measured in a
// scratch CODEX_HOME: tables appended to config.toml after a blank line (comments kept), removed
// again with that blank line, the plugin copied into plugins/cache/<marketplace>/<name>/<version>/
// (removed on `plugin remove`, the empty parent dirs left), and an empty .tmp/marketplaces/.
// It never touches hook trust entries ([hooks.state."..."]), which Codex also leaves behind.
// FAKE_CODEX_FAIL=<subcommand> makes that subcommand fail (exit 1) without side effects.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const home: string = process.env.CODEX_HOME ?? '';
if (!home) {
  process.stderr.write('fake codex: CODEX_HOME must be set in tests\n');
  process.exit(2);
}
const args = process.argv.slice(2);
const sub = args.slice(0, args[1] === 'marketplace' ? 3 : 2).join(' ');
if (process.env.FAKE_CODEX_FAIL && sub.endsWith(process.env.FAKE_CODEX_FAIL)) {
  process.stderr.write(`fake codex: ${sub} failed\n`);
  process.exit(1);
}
const configPath = join(home, 'config.toml');
const config = () => (existsSync(configPath) ? readFileSync(configPath, 'utf8') : '');

function appendTable(header: string, body: string): void {
  const text = config();
  const sep = text === '' ? '' : text.endsWith('\n') ? '\n' : '\n\n';
  writeFileSync(configPath, `${text}${sep}${header}\n${body}`);
}

function removeTable(header: string): void {
  const lines = config().split('\n');
  const at = lines.indexOf(header);
  if (at < 0) return;
  let end = at + 1;
  while (end < lines.length && !lines[end]!.startsWith('[')) end++;
  // The blank line before the next table belongs to it; drop the one before ours instead.
  const tableEnd = end < lines.length && lines[end - 1] === '' ? end - 1 : end;
  const start = at > 0 && lines[at - 1] === '' ? at - 1 : at;
  lines.splice(start, tableEnd - start);
  writeFileSync(configPath, lines.join('\n'));
}

function marketplaceDir(name: string): string {
  const m = /source = "([^"]*)"/.exec(config().split(`[marketplaces.${name}]`)[1] ?? '');
  return m![1]!;
}

function main(): number {
  if (sub === 'plugin marketplace add') {
    const dir = args[3]!;
    const name = JSON.parse(readFileSync(join(dir, '.agents', 'plugins', 'marketplace.json'), 'utf8')).name as string;
    mkdirSync(join(home, '.tmp', 'marketplaces'), { recursive: true });
    appendTable(`[marketplaces.${name}]`, `source_type = "local"\nsource = "${dir}"\n`);
    process.stdout.write(`Added marketplace \`${name}\` from ${dir}.\n`);
    return 0;
  }
  if (sub === 'plugin add') {
    // FAKE_CODEX_PAUSE=<path>: write <path>, then wait up to 20 s for <path>.release, so a test can kill setup here.
    const pause = process.env.FAKE_CODEX_PAUSE;
    if (pause) {
      writeFileSync(pause, 'SYNTHETIC_PLUGIN_ADD_WAIT');
      for (const until = Date.now() + 20_000; !existsSync(`${pause}.release`) && Date.now() < until;) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
    const id = args[2]!;
    const [name, mp] = id.split('@') as [string, string];
    const dir = marketplaceDir(mp);
    const entry = JSON.parse(readFileSync(join(dir, '.agents', 'plugins', 'marketplace.json'), 'utf8')).plugins.find((p: { name: string }) => p.name === name);
    const src = join(dir, entry.source.path);
    const version = JSON.parse(readFileSync(join(src, '.codex-plugin', 'plugin.json'), 'utf8')).version as string;
    cpSync(src, join(home, 'plugins', 'cache', mp, name, version), { recursive: true });
    appendTable(`[plugins."${id}"]`, 'enabled = true\n');
    process.stdout.write(`Added plugin \`${name}\` from marketplace \`${mp}\`.\n`);
    return 0;
  }
  if (sub === 'plugin remove') {
    const id = args[2]!;
    const [name, mp] = id.split('@') as [string, string];
    rmSync(join(home, 'plugins', 'cache', mp, name), { recursive: true, force: true });
    removeTable(`[plugins."${id}"]`);
    process.stdout.write(`Removed plugin \`${name}\` from marketplace \`${mp}\`.\n`);
    return 0;
  }
  if (sub === 'plugin marketplace remove') {
    removeTable(`[marketplaces.${args[3]}]`);
    process.stdout.write(`Removed marketplace \`${args[3]}\`.\n`);
    return 0;
  }
  if (args[0] === 'debug' && args[1] === 'prompt-input') {
    process.stdout.write(`${JSON.stringify(promptInput(args.at(-1) ?? ''))}\n`);
    return 0;
  }
  process.stderr.write(`fake codex: unsupported: ${args.join(' ')}\n`);
  return 1;
}

/**
 * `debug prompt-input`, reduced to what setup checks: the project's .codex/config.toml applies only
 * when ~/.codex/config.toml trusts the project (cwd or a parent), as in codex-cli 0.160.0; its
 * top-level developer_instructions and its token_budget guidance_message then appear as developer
 * messages. FAKE_CODEX_TOKEN_BUDGET_GONE=1 stands for a Codex release where the flag no longer works.
 */
function promptInput(prompt: string): object[] {
  const items: object[] = [];
  const dev = (text: string) => items.push({ type: 'message', role: 'developer', content: [{ type: 'input_text', text }] });
  const project = projectConfig();
  if (project) {
    const top = project.split(/\n\s*\[/)[0]!;
    const di = /^developer_instructions = (".*")$/m.exec(top);
    if (di) dev(JSON.parse(di[1]!));
    const table = project.split('[features.token_budget]')[1]?.split(/\n\s*\[/)[0];
    const guidance = table && /^enabled = true$/m.test(table) ? /^guidance_message = (".*")$/m.exec(table) : null;
    if (guidance && process.env.FAKE_CODEX_TOKEN_BUDGET_GONE !== '1') dev(`<context_window_guidance>\n${JSON.parse(guidance[1]!)}\n</context_window_guidance>`);
  }
  items.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: `<environment_context><cwd>${process.cwd()}</cwd></environment_context>` }] });
  items.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] });
  return items;
}

function projectConfig(): string | null {
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    const at = config().indexOf(`[projects.${JSON.stringify(dir)}]`);
    if (at >= 0 && /^\s*trust_level\s*=\s*"trusted"/m.test(config().slice(at).split(/\n\s*\[/)[0]!)) {
      const p = join(process.cwd(), '.codex', 'config.toml');
      return existsSync(p) ? readFileSync(p, 'utf8') : null;
    }
    if (dirname(dir) === dir) return null;
  }
}

/** `app-server --listen stdio://`: just hooks/list and config/batchWrite, for hook trust. */
function appServer(): void {
  const events = ['pre_tool_use', 'post_tool_use', 'pre_compact', 'user_prompt_submit', 'stop'];
  const hooks = () =>
    existsSync(join(home, 'plugins', 'cache', 'context-engine'))
      ? events.map((e) => {
          const key = `context-engine@context-engine:hooks/hooks.json:${e}:0:0`;
          const currentHash = `sha256:${e.padEnd(64, '0').slice(0, 64)}`;
          const trusted = config().includes(`[hooks.state."${key}"]\ntrusted_hash = "${currentHash}"`);
          return { key, pluginId: 'context-engine@context-engine', currentHash, trustStatus: trusted ? 'trusted' : 'untrusted' };
        })
      : [];
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
      const msg = JSON.parse(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      if (msg.id === undefined) continue;
      let result: unknown = {};
      if (msg.method === 'hooks/list') result = { data: [{ cwd: msg.params.cwds[0], hooks: hooks() }] };
      if (msg.method === 'config/batchWrite') {
        for (const e of msg.params.edits as Array<{ keyPath: string; value: string }>) {
          appendTable(`[${e.keyPath.replace(/\.trusted_hash$/, '')}]`, `trusted_hash = "${e.value}"\n`);
        }
        result = { status: 'ok' };
      }
      const reply = () => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n`);
      const pause = process.env.FAKE_CODEX_TRUST_PAUSE;
      if (pause && msg.method === 'hooks/list' && !existsSync(`${pause}.release`)) {
        writeFileSync(pause, 'SYNTHETIC_TRUST_WAIT');
        const timer = setInterval(() => { if (existsSync(`${pause}.release`)) { clearInterval(timer); reply(); } }, 10);
      } else reply();
    }
  });
}

if (args[0] === 'app-server') appServer();
else process.exitCode = main();
