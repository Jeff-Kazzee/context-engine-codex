import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { world } from './testing/world.ts';
import { setupContext, codexSpec } from './runners.ts';
import { install } from './install.ts';
import { enableProject } from './project.ts';
import { participation, setParticipation } from '../core/index.ts';
import { takeSnapshot } from './ledger.ts';

test('wave8: linked runner temporary root refuses before fake runner commands', () => {
  const w = world(), ctx = setupContext(w.env), outside = join(w.home, 'outside');
  fs.mkdirSync(outside); fs.symlinkSync(outside, join(w.codexHome, '.tmp'));
  assert.throws(() => install(ctx, codexSpec(ctx)), /linked|watch/);
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.equal(fs.existsSync(join(ctx.setupDir, 'codex.json')), false);
});

for (const prior of ['off', 'on']) test('wave8: failed enable remains off with malformed ledger; prior ' + prior, () => {
  const w = world(), ctx = setupContext(w.env);
  setParticipation({ projectRoot: w.project, stateDir: dirname(ctx.setupDir), state: prior as 'on' | 'off' });
  fs.mkdirSync(ctx.setupDir, { recursive: true, mode: 0o700 }); fs.writeFileSync(join(ctx.setupDir, 'codex.json'), '{invalid');
  assert.throws(() => enableProject(ctx, w.project));
  assert.equal(participation({ projectRoot: w.project, stateDir: dirname(ctx.setupDir), env: {} }).active, false);
});

test('wave8: absent ledger permits scoped participation without claiming installation', () => {
  const w = world(), ctx = setupContext(w.env);
  assert.match(enableProject(ctx, w.project).join('\n'), /adapter not installed/);
  assert.equal(participation({ projectRoot: w.project, stateDir: dirname(ctx.setupDir), env: {} }).active, true);
});

for (const kind of ['linked', 'file']) test('wave8: watched-root preflight refuses before any snapshot directory: ' + kind, () => {
  const w = world(), watch = join(w.home, 'watched'), backupRoot = join(w.stateDir, 'backups');
  if (kind === 'linked') fs.symlinkSync(w.codexHome, watch); else fs.writeFileSync(watch, 'not a directory');
  assert.throws(() => takeSnapshot({ backupRoot, kind: 'synthetic', files: [], watch: [watch], namespaced: [] }), /linked|watched root/);
  assert.equal(fs.existsSync(backupRoot), false);
});

test('wave8: missing watched roots still allow an ordinary snapshot', () => {
  const w = world(), watch = join(w.home, 'absent');
  const snapshot = takeSnapshot({ backupRoot: join(w.stateDir, 'backups'), kind: 'synthetic', files: [], watch: [watch], namespaced: [] });
  assert.deepEqual(snapshot.listing, []); assert.equal(fs.existsSync(watch), false);
});

test('wave8: linked ledger enable refusal leaves explicit off without reading the target', () => {
  const w = world(), ctx = setupContext(w.env), target = join(w.home, 'synthetic-target');
  fs.writeFileSync(target, 'SYNTHETIC_KEEP'); fs.mkdirSync(ctx.setupDir, { recursive: true, mode: 0o700 });
  fs.symlinkSync(target, join(ctx.setupDir, 'codex.json'));
  assert.throws(() => enableProject(ctx, w.project), /linked/);
  assert.equal(participation({ projectRoot: w.project, stateDir: dirname(ctx.setupDir), env: {} }).active, false);
  assert.equal(fs.readFileSync(target, 'utf8'), 'SYNTHETIC_KEEP');
});
