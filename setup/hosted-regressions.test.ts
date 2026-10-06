
// New hosted-review regressions use scratch homes and synthetic config only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { world, tree } from './testing/world.ts';
import { takeSnapshot, rollbackSnapshot, completeLedger } from './ledger.ts';
const runtime: string = 'codex';
test('linked install pointer refuses before runner commands or target creation', () => {
  const w = world(); mkdirSync(join(w.stateDir, 'setup'), { recursive: true });
  const target = join(runtime === 'claude' ? w.codexHome : w.claudeHome, 'unowned-config.json');
  const pointer = join(w.stateDir, 'setup', `${runtime}.json`);
  symlinkSync(target, pointer);
  const beforeClaude = tree(w.claudeHome), beforeCodex = tree(w.codexHome);
  const r = w.ce(['install']); assert.equal(r.status, 1); assert.match(r.stderr, /linked/);
  assert.equal(existsSync(target), false);
  assert.deepEqual(tree(w.claudeHome), beforeClaude); assert.deepEqual(tree(w.codexHome), beforeCodex);
});
for (const action of ['rollback', 'complete']) test(`${action} retains unowned empty directories`, () => {
  const w = world(), owned = join(w.stateDir, 'watched', 'owned'), unowned = join(w.stateDir, 'watched', 'another-plugin');
  mkdirSync(join(w.stateDir, 'watched'), { recursive: true });
  const snapshot = takeSnapshot({ backupRoot: join(w.stateDir, 'backups'), kind: 'test', files: [], watch: [join(w.stateDir, 'watched')], namespaced: [owned] });
  mkdirSync(owned); mkdirSync(unowned);
  if (action === 'rollback') { rollbackSnapshot(snapshot, {}); assert.equal(existsSync(owned), false); }
  else assert.deepEqual(completeLedger(snapshot).createdDirs, [owned]);
  assert.equal(existsSync(unowned), true);
});
