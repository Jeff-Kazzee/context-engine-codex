import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { world } from './testing/world.ts';
import { setupContext } from './runners.ts';
import { enableProject, disableProject } from './project.ts';
import { participation } from '../core/index.ts';
import { tomlTablesRule } from './rules.ts';
import { takeSnapshot, rollbackSnapshot } from './ledger.ts';

test('wave10: failed Codex config creation restores prior absence', () => {
  const w = world(), path = join(w.codexHome, 'config.toml');
  const snap = takeSnapshot({ backupRoot: join(w.stateDir, 'backups'), kind: 'synthetic', files: [path], watch: [], namespaced: [] });
  fs.writeFileSync(path, '[plugins."owned"]\nenabled = true\n');
  rollbackSnapshot(snap, { [path]: tomlTablesRule(/^\[plugins\."owned"\]$/, /^\[plugins\]$/) });
  assert.equal(fs.existsSync(path), false);
});

for (const phase of ['before', 'after']) test('wave10: activation publication failure rolls back project guidance (' + phase + ' rename)', () => {
  const w = world(); assert.equal(w.ce(['install']).status, 0); const ctx = setupContext(w.env);
  const path = join(w.project, '.codex/config.toml'), native = fs.renameSync; let failed = false;
  fs.renameSync = ((from: any, to: any) => {
    if (!failed && fs.realpathSync(dirname(String(to))).endsWith('/participation')) {
      failed = true; if (phase === 'after') native(from, to);
      throw new Error('synthetic activation publication failure');
    }
    return native(from, to);
  }) as typeof fs.renameSync; syncBuiltinESMExports();
  try { assert.throws(() => enableProject(ctx, w.project), /synthetic activation publication failure/); }
  finally { fs.renameSync = native; syncBuiltinESMExports(); }
  assert.equal(failed, true); assert.equal(fs.existsSync(path), false);
  assert.equal(participation({ projectRoot: w.project, stateDir: w.stateDir, env: {} }).state, 'off');
  assert.equal(fs.existsSync(join(ctx.setupDir, 'projects')) && fs.readdirSync(join(ctx.setupDir, 'projects')).length > 0, false);
});

test('wave10: descendant disable shadows inherited Context Engine guidance with scoped reversible settings', () => {
  const w = world(); assert.equal(w.ce(['install']).status, 0); const ctx = setupContext(w.env);
  enableProject(ctx, w.project);
  const child = join(w.project, 'child'); fs.mkdirSync(child);
  disableProject(ctx, child);
  const config = join(child, '.codex/config.toml'), text = fs.readFileSync(config, 'utf8');
  assert.match(text, /developer_instructions = ""/); assert.match(text, /enabled = false/);
  assert.equal(participation({ projectRoot: child, stateDir: w.stateDir, env: {} }).state, 'off');
  assert.equal(participation({ projectRoot: w.project, stateDir: w.stateDir, env: {} }).state, 'on');
  enableProject(ctx, child); assert.match(fs.readFileSync(config, 'utf8'), /enabled = true/);
  assert.equal(w.ce(['uninstall']).status, 0); assert.equal(fs.existsSync(config), false);
});
