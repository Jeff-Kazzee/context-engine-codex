import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { existsSync, linkSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tempDir } from '../core/testing.ts';
import { safeRead, safeWrite } from './files.ts';

test('overlapping install and uninstall cannot share a setup transaction', () => {
  const w = world(), config = join(w.claudeHome, 'settings.json'); writeFileSync(config, 'ORIGINAL');
  const ctx: any = { setupDir: join(w.stateDir, 'setup'), env: w.env };
  const spec: any = { id: 'fake', title: 'Fake', bin: process.execPath, files: [config], watch: [w.claudeHome], namespaced: [], rules: {}, install: [], uninstall: [], prepare() {
    assert.throws(() => install(ctx, spec), /already locked/);
    assert.throws(() => uninstall(ctx, spec), /already locked/);
    writeFileSync(config, 'INSTALLED');
  } };
  install(ctx, spec); assert.ok(installedLedger(ctx, 'fake', spec)); assert.equal(readFileSync(config, 'utf8'), 'INSTALLED');
  uninstall(ctx, spec); assert.equal(readFileSync(config, 'utf8'), 'ORIGINAL');
});
import { install, installedLedger, uninstall } from './install.ts';
import { world } from './testing/world.ts';
// Synthetic specs identify their exact managed edit; unknown changed bytes stay untouched.
const managedFixtureRule = { canon: (text: string) => text, strip: (text: string, before: string | null) => text === 'CHANGED' ? before ?? '' : text };

test('pointer publication failure rolls back and can be retried', () => {
  const w = world();
  const config = join(w.claudeHome, 'settings.json');
  writeFileSync(config, 'ORIGINAL');
  const ctx: any = { setupDir: join(w.stateDir, 'setup'), env: w.env };
  const spec: any = { id: 'fake', title: 'Fake', bin: process.execPath, files: [config], watch: [w.claudeHome], namespaced: [], rules: {[config]: managedFixtureRule}, install: [], prepare() { writeFileSync(config, 'CHANGED'); } };
  const nativeRename = fs.renameSync;
  fs.renameSync = ((from: any, to: any) => {
    if (basename(String(to)) === 'fake.json' && fs.realpathSync(dirname(String(to))) === ctx.setupDir) throw Object.assign(new Error('synthetic pointer denied'), { code: 'EACCES' });
    return nativeRename(from, to);
  }) as typeof fs.renameSync;
  syncBuiltinESMExports();
  try { assert.throws(() => install(ctx, spec), /synthetic pointer denied/); }
  finally { fs.renameSync = nativeRename; syncBuiltinESMExports(); }
  assert.equal(readFileSync(config, 'utf8'), 'ORIGINAL');
  assert.equal(installedLedger(ctx, 'fake', spec), null);
  spec.prepare = undefined;
  install(ctx, spec);
  assert.ok(installedLedger(ctx, 'fake', spec));
});

test('setup never reads, backs up or overwrites linked configuration targets', () => {
  for (const kind of ['symlink', 'hardlink', 'parent'] as const) {
    const root = tempDir('safe-setup');
    const external = tempDir('external-setup');
    const sentinel = join(external, 'config.toml');
    writeFileSync(sentinel, 'SYNTHETIC-PRIVATE-SENTINEL');
    const dir = join(root, '.codex');
    if (kind === 'parent') symlinkSync(external, dir);
    else {
      mkdirSync(dir);
      if (kind === 'symlink') symlinkSync(sentinel, join(dir, 'config.toml'));
      else linkSync(sentinel, join(dir, 'config.toml'));
    }
    const config = join(dir, 'config.toml');
    assert.throws(() => safeRead(config), /linked/);
    assert.throws(() => safeWrite(config, 'overwritten'), /linked/);
    assert.equal(readFileSync(sentinel, 'utf8'), 'SYNTHETIC-PRIVATE-SENTINEL');
  }
});

test('prepare failure rolls back without needing to finalize a ledger', () => {
  const w = world();
  const config = join(w.claudeHome, 'settings.json');
  writeFileSync(config, 'ORIGINAL');
  const ctx: any = { setupDir: join(w.stateDir, 'setup'), env: w.env };
  const spec: any = { id: 'fake', title: 'Fake', bin: process.execPath, files: [config], watch: [w.claudeHome], namespaced: [], rules: {[config]: managedFixtureRule}, install: [], prepare() { writeFileSync(config, 'CHANGED'); throw new Error('prepare failed'); } };
  assert.throws(() => install(ctx, spec), /prepare failed/);
  assert.equal(readFileSync(config, 'utf8'), 'ORIGINAL');
  assert.equal(installedLedger(ctx, 'fake', spec), null);
});

test('ledger finalization failure restores config and preserves unrelated files', () => {
  const w = world();
  const config = join(w.claudeHome, 'settings.json');
  const unrelated = join(w.claudeHome, 'unrelated');
  writeFileSync(config, 'ORIGINAL'); writeFileSync(unrelated, 'KEEP');
  const ctx: any = { setupDir: join(w.stateDir, 'setup'), env: w.env };
  const owned = join(w.claudeHome, 'context-engine-owned-fixture');
  const bad = join(owned, 'unreadable-created');
  const concurrent = join(w.claudeHome, 'unrelated-new-file');
  const spec: any = { id: 'fake', title: 'Fake', bin: process.execPath, files: [config], watch: [w.claudeHome], namespaced: [owned], rules: {[config]: managedFixtureRule}, install: [], prepare() { writeFileSync(config, 'CHANGED'); writeFileSync(concurrent, 'NEW KEEP'); mkdirSync(owned); symlinkSync('/nonexistent-created-target', bad); } };
  assert.throws(() => install(ctx, spec));
  assert.equal(readFileSync(config, 'utf8'), 'ORIGINAL');
  assert.equal(readFileSync(unrelated, 'utf8'), 'KEEP');
  assert.equal(readFileSync(concurrent, 'utf8'), 'NEW KEEP');
  assert.equal(existsSync(join(ctx.setupDir, 'fake.json')), false);
});

test('successful install and uninstall preserve an unrelated file created during installation', () => {
  const w = world();
  const config = join(w.claudeHome, 'settings.json');
  const concurrent = join(w.claudeHome, 'other-plugin-new-file');
  writeFileSync(config, 'ORIGINAL');
  const ctx: any = { setupDir: join(w.stateDir, 'setup'), env: w.env };
  const spec: any = { id: 'fake', title: 'Fake', bin: process.execPath, files: [config], watch: [w.claudeHome], namespaced: [], rules: {}, install: [], uninstall: [], prepare() { writeFileSync(config, 'CHANGED'); writeFileSync(concurrent, 'UNRELATED NEW'); } };
  install(ctx, spec);
  uninstall(ctx, spec);
  assert.equal(readFileSync(config, 'utf8'), 'ORIGINAL');
  assert.equal(readFileSync(concurrent, 'utf8'), 'UNRELATED NEW');
});

test('linked plugin namespace refuses before runner commands or external writes', () => {
  const w = world(), external = tempDir('namespace-external'), linked = join(w.claudeHome, 'namespace'); symlinkSync(external, linked);
  const ctx: any = { setupDir: join(w.stateDir, 'setup'), env: w.env };
  let ran = false; const spec: any = { id: 'fake', title: 'Fake', bin: process.execPath, files: [], watch: [], namespaced: [join(linked, 'plugin')], rules: {}, install: [], prepare() { ran = true; } };
  assert.throws(() => install(ctx, spec), /linked path/); assert.equal(ran, false); assert.deepEqual(fs.readdirSync(external), []);
});
