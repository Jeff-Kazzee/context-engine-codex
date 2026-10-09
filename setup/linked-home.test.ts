import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tree, world } from './testing/world.ts';

/** Moves the runner home to a sibling directory and leaves a symbolic link at its old path. */
function linkHome(home: string): string {
  const real = `${home}-real`;
  renameSync(home, real);
  symlinkSync(real, home);
  return real;
}

test('[SAFE-011] symlinked Codex home refuses install before any write', () => {
  const w = world();
  writeFileSync(join(w.codexHome, 'config.toml'), 'model = "gpt-6-luna"\n');
  const real = linkHome(w.codexHome);
  const before = tree(real);
  const r = w.ce(['install']);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /linked path/);
  assert.deepEqual(tree(real), before);
  assert.equal(existsSync(join(w.stateDir, 'setup', 'backups')), false);
  assert.equal(existsSync(join(w.stateDir, 'setup', 'codex.json')), false);
});

test('[SAFE-011] symlinked Codex home refuses uninstall before any runner command', () => {
  const w = world();
  writeFileSync(join(w.codexHome, 'config.toml'), 'model = "gpt-6-luna"\n');
  assert.equal(w.ce(['install']).status, 0);
  const real = linkHome(w.codexHome);
  const before = tree(real);
  const r = w.ce(['uninstall']);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /linked path/);
  assert.deepEqual(tree(real), before);
  assert.equal(existsSync(join(w.stateDir, 'setup', 'codex.json')), true, 'the install record is kept');
});
