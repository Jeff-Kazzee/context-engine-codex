#!/usr/bin/env node
// Test double for `claude plugin ...` (Claude Code 2.1.289), with the side effects measured in a
// scratch CLAUDE_CONFIG_DIR (see setup/README notes in the setup tests): it rewrites settings.json
// pretty-printed with keys sorted, leaves `{}` behind on removal, writes the plugin registries,
// copies plugins into plugins/cache/<marketplace>/<name>/<version>/, marks them `.orphaned_at` on
// uninstall, and backs up .claude.json into backups/. FAKE_CLAUDE_FAIL=<subcommand> makes that
// subcommand fail (exit 1) without side effects.
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type Json = Record<string, any>;
const home: string = process.env.CLAUDE_CONFIG_DIR ?? '';
if (!home) {
  process.stderr.write('fake claude: CLAUDE_CONFIG_DIR must be set in tests\n');
  process.exit(2);
}
const args = process.argv.slice(2);
const sub = args.slice(0, args[1] === 'marketplace' ? 3 : 2).join(' ');
if (process.env.FAKE_CLAUDE_FAIL && sub.endsWith(process.env.FAKE_CLAUDE_FAIL)) {
  process.stderr.write(`fake claude: ${sub} failed\n`);
  process.exit(1);
}

const sorted = (v: unknown): unknown =>
  v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted((v as Json)[k])])) : v;
const read = (path: string, fallback: Json): Json => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback);
const settingsPath = join(home, 'settings.json');
const knownPath = join(home, 'plugins', 'known_marketplaces.json');
const installedPath = join(home, 'plugins', 'installed_plugins.json');
const settings = () => read(settingsPath, {});
const saveSettings = (s: Json) => writeFileSync(settingsPath, `${JSON.stringify(sorted(s), null, 2)}\n`);
const save = (path: string, v: Json) => {
  mkdirSync(join(home, 'plugins'), { recursive: true });
  writeFileSync(path, JSON.stringify(v, null, 2));
};

function main(): number {
  if (sub === 'plugin marketplace add') {
    const dir = args[3]!;
    const name = JSON.parse(readFileSync(join(dir, '.claude-plugin', 'marketplace.json'), 'utf8')).name as string;
    mkdirSync(join(home, 'backups'), { recursive: true });
    writeFileSync(join(home, 'backups', `.claude.json.backup.${Date.now()}`), '{}\n');
    mkdirSync(join(home, 'plugins', 'marketplaces'), { recursive: true });
    const s = settings();
    s.extraKnownMarketplaces = { ...(s.extraKnownMarketplaces ?? {}), [name]: { source: { source: 'directory', path: dir } } };
    saveSettings(s);
    save(knownPath, { ...read(knownPath, {}), [name]: { source: { source: 'directory', path: dir }, installLocation: dir } });
    process.stdout.write(`✔ Successfully added marketplace: ${name}\n`);
    return 0;
  }
  if (sub === 'plugin install') {
    const id = args[2]!;
    const [name, mp] = id.split('@') as [string, string];
    const dir = read(knownPath, {})[mp]?.installLocation as string;
    const entry = JSON.parse(readFileSync(join(dir, '.claude-plugin', 'marketplace.json'), 'utf8')).plugins.find((p: Json) => p.name === name);
    const src = join(dir, entry.source);
    const version = JSON.parse(readFileSync(join(src, '.claude-plugin', 'plugin.json'), 'utf8')).version as string;
    cpSync(src, join(home, 'plugins', 'cache', mp, name, version), { recursive: true });
    const s = settings();
    s.enabledPlugins = { ...(s.enabledPlugins ?? {}), [id]: true };
    saveSettings(s);
    const installed = read(installedPath, { version: 2, plugins: {} });
    installed.plugins[id] = [{ scope: 'user', installPath: src, version }];
    save(installedPath, installed);
    process.stdout.write(`✔ Successfully installed plugin: ${id}\n`);
    return 0;
  }
  if (sub === 'plugin uninstall') {
    const id = args[2]!;
    const [name, mp] = id.split('@') as [string, string];
    const s = settings();
    delete s.enabledPlugins?.[id];
    saveSettings(s);
    const installed = read(installedPath, { version: 2, plugins: {} });
    const version = installed.plugins[id]?.[0]?.version;
    delete installed.plugins[id];
    save(installedPath, installed);
    if (version) writeFileSync(join(home, 'plugins', 'cache', mp, name, version, '.orphaned_at'), String(Date.now()));
    process.stdout.write(`✔ Successfully uninstalled plugin: ${name}\n`);
    return 0;
  }
  if (sub === 'plugin marketplace remove') {
    const name = args[3]!;
    const s = settings();
    delete s.extraKnownMarketplaces?.[name];
    saveSettings(s);
    const known = read(knownPath, {});
    delete known[name];
    save(knownPath, known);
    process.stdout.write(`✔ Successfully removed marketplace: ${name}\n`);
    return 0;
  }
  process.stderr.write(`fake claude: unsupported: ${args.join(' ')}\n`);
  return 1;
}

process.exitCode = main();
