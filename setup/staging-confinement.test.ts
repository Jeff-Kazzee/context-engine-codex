import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdirSync, readdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { participation } from '../core/index.ts';
import { tempDir } from '../core/testing.ts';
import { installLocked } from './install.ts';
import { codexSpec, setupContext } from './runners.ts';
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

test('[SAFE-012] a linked staging directory refuses install by name without a stack trace', () => {
  const w = world();
  const config = join(w.codexHome, 'config.toml');
  writeFileSync(config, '# my codex config\n');
  mkdirSync(join(w.stateDir, 'setup'), { recursive: true, mode: 0o700 });
  const outside = tempDir('outside');
  writeFileSync(join(outside, 'sentinel'), 'SENTINEL');
  const staged = join(w.stateDir, 'setup', 'codex-marketplace');
  symlinkSync(outside, staged);
  const r = w.ce(['install']);
  assert.notEqual(r.status, 0, 'install refuses a linked staging directory');
  assert.ok(r.stderr.includes(staged), `install names ${staged}:\n${r.stderr}`);
  assert.doesNotMatch(r.stderr, /^\s+at /m, 'install prints no stack trace');
  assert.deepEqual(readdirSync(outside), ['sentinel']);
  assert.equal(fs.readFileSync(config, 'utf8'), '# my codex config\n');
});

test('[SAFE-012] a staging directory that becomes a link after its removal cannot redirect the copy', () => {
  const w = world();
  const ctx = setupContext({ ...process.env, ...w.env });
  const outside = tempDir('outside');
  writeFileSync(join(outside, 'sentinel'), 'SENTINEL');
  const before = tree(outside);
  const native = fs.rmSync;
  let planted = false, error: unknown;
  fs.rmSync = ((path: fs.PathLike, ...rest: any[]) => {
    const result = (native as any)(path, ...rest);
    if (!planted && String(path).endsWith('/codex-marketplace')) {
      planted = true;
      symlinkSync(outside, join(ctx.setupDir, 'codex-marketplace'));
    }
    return result;
  }) as typeof fs.rmSync;
  syncBuiltinESMExports();
  try { installLocked(ctx, codexSpec(ctx)); }
  catch (e) { error = e; }
  finally { fs.rmSync = native; syncBuiltinESMExports(); }
  assert.equal(planted, true, 'staging removed its directory');
  assert.deepEqual(tree(outside), before, 'nothing was copied into the outside directory');
  assert.ok(error, 'install refused the linked staging directory');
});

test('[SAFE-012] swapped codex-marketplace staging dir cannot copy or delete outside the state root', () => {
  const w = world();
  const ctx = setupContext({ ...process.env, ...w.env });
  const outside = tempDir('outside');
  mkdirSync(join(outside, 'codex-marketplace'));
  writeFileSync(join(outside, 'codex-marketplace', 'sentinel'), 'SENTINEL');
  const before = tree(outside);
  const native = fs.rmSync;
  let swapped = false;
  fs.rmSync = ((path: fs.PathLike, ...rest: any[]) => {
    if (!swapped && String(path).endsWith('/codex-marketplace')) {
      swapped = true;
      renameSync(ctx.setupDir, `${ctx.setupDir}-held`);
      symlinkSync(outside, ctx.setupDir);
    }
    return (native as any)(path, ...rest);
  }) as typeof fs.rmSync;
  syncBuiltinESMExports();
  try { assert.throws(() => installLocked(ctx, codexSpec(ctx))); }
  finally { fs.rmSync = native; syncBuiltinESMExports(); }
  assert.equal(swapped, true, 'staging removed its directory');
  assert.deepEqual(tree(outside), before, 'nothing was copied into or deleted from the outside directory');
});
