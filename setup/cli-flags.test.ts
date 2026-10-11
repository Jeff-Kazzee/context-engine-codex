import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tree, world } from './testing/world.ts';

test('[CLI-007] Codex CLI unknown flag fails without state change', () => {
  const w = world();
  const r = w.ce(['install', '--bogus']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--bogus/);
  assert.equal(existsSync(join(w.stateDir, 'setup')), false);
  assert.deepEqual(tree(w.codexHome), {});
});

test('[CLI-007] Codex CLI refuses --claude before any change', () => {
  const w = world();
  const r = w.ce(['install', '--claude']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /supports codex only/);
  assert.equal(existsSync(join(w.stateDir, 'setup')), false);
  assert.deepEqual([tree(w.claudeHome), tree(w.codexHome)], [{}, {}]);
});
