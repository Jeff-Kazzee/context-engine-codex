import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tree, world } from './testing/world.ts';

test('[LIFE-010] inline table in tracked config refuses install before backup', () => {
  const w = world();
  const config = join(w.codexHome, 'config.toml');
  const text = '[tools]\nx = { a = 1 }\n';
  writeFileSync(config, text);
  const home = tree(w.codexHome);
  const r = w.ce(['install']);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /unsafe configuration cannot be backed up/);
  assert.equal(existsSync(join(w.stateDir, 'setup', 'backups')), false);
  assert.equal(readFileSync(config, 'utf8'), text);
  assert.deepEqual(tree(w.codexHome), home);
});
