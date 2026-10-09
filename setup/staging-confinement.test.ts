import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { participation } from '../core/index.ts';
import { tempDir } from '../core/testing.ts';
import { tree, world } from './testing/world.ts';

test('[SAFE-012] linked project pointer dir refuses enable without outside writes', () => {
  const w = world();
  assert.equal(w.ce(['install']).status, 0);
  const outside = tempDir('outside');
  writeFileSync(join(outside, 'sentinel'), 'SENTINEL');
  const projects = join(w.stateDir, 'setup', 'projects');
  mkdirSync(projects, { recursive: true, mode: 0o700 });
  renameSync(projects, `${projects}-held`);
  symlinkSync(outside, projects);
  const project = tree(w.project);

  const r = w.ce(['enable']);
  assert.notEqual(r.status, 0, r.stdout);
  assert.deepEqual(readdirSync(outside), ['sentinel']);
  assert.equal(participation({ projectRoot: w.project, stateDir: w.stateDir, env: {} }).active, false);
  assert.deepEqual(tree(w.project), project, 'the project config was rolled back');
});
