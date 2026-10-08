import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tempDir } from '../core/testing.ts';
import { safeRead, safeWrite } from './files.ts';
import { setupContext } from './runners.ts';
import { takeSnapshot, completeLedger, assess, revert } from './ledger.ts';
import { jsonRule } from './rules.ts';

test('wave10: setup writes sync file before publication and parent before success', () => {
  const dir = tempDir('setup-sync'), path = join(dir, 'config.json'), calls: string[] = [];
  const sync = fs.fsyncSync, rename = fs.renameSync;
  fs.fsyncSync = ((fd: number) => { calls.push(fs.fstatSync(fd).isDirectory() ? 'directory' : 'file'); sync(fd); }) as typeof fs.fsyncSync;
  fs.renameSync = ((from: any, to: any) => { calls.push('rename'); rename(from, to); }) as typeof fs.renameSync;
  syncBuiltinESMExports();
  try { safeWrite(path, '{}'); } finally { fs.fsyncSync = sync; fs.renameSync = rename; syncBuiltinESMExports(); }
  assert.deepEqual(calls, ['file', 'rename', 'directory']);
});

test('wave10: setup refuses oversized files before allocation', () => {
  const path = join(tempDir('setup-bound'), 'config.json'); fs.writeFileSync(path, ''); fs.truncateSync(path, 16 * 1024 * 1024 + 1);
  assert.throws(() => safeRead(path), /16 MiB read limit/);
});

test('wave10: relative Claude home is canonicalized at setup entry', () => {
  const ctx = setupContext({ HOME: tempDir('home'), CLAUDE_CONFIG_DIR: 'synthetic-relative-claude', CONTEXT_ENGINE_STATE_DIR: tempDir('state') });
  assert.equal(ctx.claudeHome, join(process.cwd(), 'synthetic-relative-claude'));
});

test('wave10: unmanaged edit made during successful install survives uninstall assessment', () => {
  const dir = tempDir('successful-concurrent'), config = join(dir, 'settings.json');
  fs.writeFileSync(config, '{"theme":"before"}\n');
  const snapshot = takeSnapshot({ backupRoot: join(dir, 'backups'), kind: 'synthetic', files: [config], watch: [], namespaced: [] });
  fs.writeFileSync(config, '{"theme":"concurrent","enabledPlugins":{"owned":true}}\n');
  const ledger = completeLedger(snapshot), rules = { [config]: jsonRule([['enabledPlugins', 'owned']]) };
  revert(ledger, rules, assess(ledger, rules));
  assert.deepEqual(JSON.parse(fs.readFileSync(config, 'utf8')), { theme: 'concurrent' });
});

test('wave10: setup parent swap cannot create directories in an external tree', () => {
  const root = tempDir('setup-parent-race'), outside = tempDir('setup-external'), original = join(root, 'parent'); fs.mkdirSync(original);
  const native = fs.mkdirSync; let swapped = false;
  fs.mkdirSync = ((path: any, opts: any) => {
    if (!swapped && (String(path).startsWith(original) || String(path).startsWith('/proc/self/fd/') && fs.realpathSync(join(String(path), '..')) === original)) {
      swapped = true; fs.renameSync(original, original + '.old'); fs.symlinkSync(outside, original);
    }
    return native(path, opts);
  }) as typeof fs.mkdirSync; syncBuiltinESMExports();
  try { assert.throws(() => safeWrite(join(original, 'missing', 'config.json'), '{}'), /changed|verify|linked/); }
  finally { fs.mkdirSync = native; syncBuiltinESMExports(); }
  assert.equal(swapped, true); assert.deepEqual(fs.readdirSync(outside), []);
});
