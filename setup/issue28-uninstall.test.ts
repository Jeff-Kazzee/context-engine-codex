import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FAKE_CLAUDE, FAKE_CODEX, tree, world } from './testing/world.ts';

const runtime = JSON.parse(readFileSync(new URL('../SOURCE.json', import.meta.url), 'utf8')).runtime as 'claude' | 'codex';
const plugin = 'context-engine@context-engine';

function installed(preexistingNamespace = false, originallyAbsent = false) {
  const w = world();
  const home = runtime === 'claude' ? w.claudeHome : w.codexHome;
  const config = join(home, runtime === 'claude' ? 'settings.json' : 'config.toml');
  const original = runtime === 'claude' ? '{"theme":"dark","enabledPlugins":{"other@other":true}}\n' : '# my configuration\nmodel = "offline-fixture"\n';
  if (!originallyAbsent) writeFileSync(config, original);
  const cache = join(home, 'plugins', 'cache', 'context-engine');
  if (preexistingNamespace) {
    mkdirSync(cache, { recursive: true, mode: 0o700 });
    writeFileSync(join(cache, 'user-note'), 'keep this namespace');
  }
  const calls = join(w.home, 'runner-calls');
  const wrapper = join(w.home, 'runner.ts');
  const fake = runtime === 'claude' ? FAKE_CLAUDE : FAKE_CODEX;
  writeFileSync(wrapper, `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n');\nawait import(${JSON.stringify(fake)});\n`);
  w.env[runtime === 'claude' ? 'CONTEXT_ENGINE_CLAUDE_BIN' : 'CONTEXT_ENGINE_CODEX_BIN'] = wrapper;
  const r = w.ce(['install']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  writeFileSync(calls, '');
  const pointer = join(w.stateDir, 'setup', `${runtime}.json`);
  const dir = JSON.parse(readFileSync(pointer, 'utf8')).dir as string;
  const ledger = JSON.parse(readFileSync(join(dir, 'ledger.json'), 'utf8')) as {
    files: Array<{ path: string; before: string | null; after: string | null }>;
    namespaced: Array<{ path: string; existed: boolean }>;
  };
  const tracked = ledger.files.find(f => f.path === config)!;
  const change = () => {
    const text = readFileSync(config, 'utf8');
    if (runtime === 'claude') {
      const value = JSON.parse(text);
      value.enabledPlugins[plugin] = false;
      value.theme = 'changed';
      writeFileSync(config, `${JSON.stringify(value)}\n`);
    } else writeFileSync(config, text.replace('enabled = true', 'enabled = false').replace('offline-fixture', 'changed'));
  };
  const enabled = () => runtime === 'claude' ? JSON.parse(readFileSync(config, 'utf8')).enabledPlugins?.[plugin] :
    /\[plugins\."context-engine@context-engine"\]\s*enabled = (true|false)/.exec(readFileSync(config, 'utf8'))?.[1];
  const cleanup = () => {
    assert.equal(existsSync(pointer), false, 'the completed install record is retired');
    assert.equal(existsSync(dir), true, 'the backup snapshot is retained');
    for (const n of ledger.namespaced) if (!n.existed) assert.equal(existsSync(n.path), false, `created namespace removed: ${n.path}`);
  };
  return { w, home, config, original, cache, calls, pointer, dir, tracked, change, enabled, cleanup };
}

test(`[issue28] ${runtime} completed uninstall preserves changed managed values when the before backup is lost`, () => {
  const f = installed();
  f.change();
  unlinkSync(f.tracked.before!);
  const r = f.w.ce(['uninstall']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(f.enabled(), runtime === 'claude' ? false : 'false', 'a value the install did not write survives completed uninstall');
  assert.match(readFileSync(f.config, 'utf8'), /changed/, 'unmanaged edits survive too');
  assert.match(r.stdout, /left in place because the backup copy is missing/);
  assert.ok(r.stdout.includes(f.tracked.before!), 'the report names the lost copy');
  assert.equal(readFileSync(f.calls, 'utf8'), '', 'native removal cannot erase unproved values before assessment');
  assert.match(r.stdout, /native uninstall commands were not run/);
  assert.match(r.stdout, /Native-only effects are unverified/);
  f.cleanup();
});

test(`[issue28] ${runtime} missing before backup still removes proven install values and created namespaces`, () => {
  const f = installed();
  unlinkSync(f.tracked.before!);
  const r = f.w.ce(['uninstall']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(f.enabled(), undefined);
  assert.match(readFileSync(f.config, 'utf8'), runtime === 'claude' ? /dark/ : /offline-fixture/);
  assert.equal(readFileSync(f.calls, 'utf8'), '');
  f.cleanup();
});

test(`[issue28] ${runtime} an originally absent file still uses native uninstall`, () => {
  const f = installed(false, true);
  assert.equal(f.tracked.before, null, 'no before copy was required');
  const r = f.w.ce(['uninstall']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  if (runtime === 'claude') assert.equal(existsSync(f.config), false, 'the empty JSON file created by installation is removed');
  else assert.doesNotMatch(readFileSync(f.config, 'utf8'), /context-engine/, 'the native TOML removal leaves no managed entries');
  assert.match(readFileSync(f.calls, 'utf8'), /(?:uninstall|remove)/);
  assert.doesNotMatch(r.stdout, /native uninstall commands were not run/);
  f.cleanup();
});

test(`[issue28] ${runtime} backup-present uninstall keeps native removal and restores original bytes`, () => {
  const f = installed();
  const r = f.w.ce(['uninstall']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(readFileSync(f.config, 'utf8'), f.original);
  assert.match(readFileSync(f.calls, 'utf8'), /(?:uninstall|remove)/, 'native removal runs with intact before evidence');
  f.cleanup();
});

test(`[issue28] ${runtime} after-copy loss retains native removal and unmanaged edits`, () => {
  const f = installed();
  f.change();
  unlinkSync(f.tracked.after!);
  const r = f.w.ce(['uninstall']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(f.enabled(), undefined, 'the intact before backup still proves the managed key policy');
  assert.match(readFileSync(f.config, 'utf8'), /changed/);
  assert.match(readFileSync(f.calls, 'utf8'), /(?:uninstall|remove)/);
  assert.ok(r.stdout.includes(f.tracked.after!), 'the report names the lost after copy');
  assert.doesNotMatch(r.stdout, /restored byte for byte/);
  f.cleanup();
});

test(`[issue28] ${runtime} untrusted backup refuses before native removal or file changes`, () => {
  const f = installed();
  f.change();
  linkSync(f.tracked.before!, join(f.w.home, 'second-link'));
  const home = tree(f.home), state = tree(f.w.stateDir);
  const r = f.w.ce(['uninstall']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /uninstall changed nothing/);
  assert.deepEqual(tree(f.home), home);
  assert.deepEqual(tree(f.w.stateDir), state);
  assert.equal(readFileSync(f.calls, 'utf8'), '');
});

test(`[issue28] ${runtime} missing before backup preserves a preexisting namespace`, () => {
  const f = installed(true);
  f.change();
  unlinkSync(f.tracked.before!);
  const r = f.w.ce(['uninstall']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(readFileSync(join(f.cache, 'user-note'), 'utf8'), 'keep this namespace');
  assert.equal(f.enabled(), runtime === 'claude' ? false : 'false');
  f.cleanup();
});
