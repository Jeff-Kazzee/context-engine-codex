import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { setupContext } from './runners.ts';
import { tempDir } from '../core/testing.ts';
import fs from 'node:fs';
import { world } from './testing/world.ts';
import { participation } from '../core/participation.ts';

for (const text of [
  'features.token_budget.enabled = false\n',
  '[features]\ntoken_budget.enabled = false\n',
  '[features.token_budget.child]\nenabled = false\n',
  '[[features.token_budget]]\nenabled = false\n',
  '["features"]\n"token_budget".enabled = false\n',
]) test('wave7: Codex unmanaged subtree refuses without activation: ' + JSON.stringify(text), () => {
  const w = world(), config = join(w.project, '.codex', 'config.toml');
  assert.equal(w.ce(['install']).status, 0);
  fs.mkdirSync(join(w.project, '.codex'), { recursive: true }); fs.writeFileSync(config, text);
  const result = w.ce(['enable']); assert.equal(result.status, 1);
  assert.match(result.stderr, /token_budget/); assert.equal(fs.readFileSync(config, 'utf8'), text);
  assert.equal(participation({ projectRoot: w.project, stateDir: w.stateDir, env: w.env }).active, false);
});

test('wave7: Codex comments and literal/string subtree mentions remain benign', () => {
  const w = world(), config = join(w.project, '.codex', 'config.toml');
  assert.equal(w.ce(['install']).status, 0);
  fs.mkdirSync(join(w.project, '.codex'), { recursive: true });
  const text = '# [features.token_budget.child]\n"features.token_budget.enabled" = false\ndescription = """\n[features.token_budget]\nfeatures.token_budget.enabled = false\n"""\n';
  fs.writeFileSync(config, text); assert.equal(w.ce(['enable']).status, 0);
  assert.equal(w.ce(['disable']).status, 0); assert.equal(fs.readFileSync(config, 'utf8'), text);
});

test('wave7: supplied setup environment isolates CE, XDG and HOME roots', () => {
  const home = tempDir('supplied-home');
  const ambient = process.env.CONTEXT_ENGINE_STATE_DIR;
  process.env.CONTEXT_ENGINE_STATE_DIR = join(home, 'ambient');
  try {
    assert.equal(setupContext({ HOME: home, CONTEXT_ENGINE_STATE_DIR: join(home, 'explicit') }).setupDir, join(home, 'explicit', 'setup'));
    assert.equal(setupContext({ HOME: home, XDG_STATE_HOME: join(home, 'xdg') }).setupDir, join(home, 'xdg', 'context-engine', 'setup'));
    assert.equal(setupContext({ HOME: home }).setupDir, join(home, '.local', 'state', 'context-engine', 'setup'));
    assert.throws(() => setupContext({ HOME: home, CONTEXT_ENGINE_STATE_DIR: 'relative' }), /absolute/);
    assert.equal(setupContext().setupDir, join(home, 'ambient', 'setup'));
  } finally {
    if (ambient === undefined) delete process.env.CONTEXT_ENGINE_STATE_DIR;
    else process.env.CONTEXT_ENGINE_STATE_DIR = ambient;
  }
});


import { enableProject, disableProject } from './project.ts';
import { findRecord } from '../core/participation.ts';
import { statusText } from './status.ts';

test('wave7: context participation and status stay in the supplied state root', async () => {
  const w = world(), ctx = setupContext(w.env);
  const ambient = process.env.CONTEXT_ENGINE_STATE_DIR;
  process.env.CONTEXT_ENGINE_STATE_DIR = join(tempDir('ambient-state'), 'context-engine');
  try {
  enableProject(ctx, w.project);
  assert.equal(findRecord({ projectRoot: w.project, stateDir: w.stateDir })?.state, 'on');
  assert.equal(findRecord({ projectRoot: w.project }), null, 'ambient scratch root has no record');
  const status = await statusText(ctx, w.project);
  assert.equal((status.json.participation as { state: string }).state, 'on');
  disableProject(ctx, w.project);
  assert.equal(findRecord({ projectRoot: w.project, stateDir: w.stateDir })?.state, 'off');
  } finally {
    if (ambient === undefined) delete process.env.CONTEXT_ENGINE_STATE_DIR;
    else process.env.CONTEXT_ENGINE_STATE_DIR = ambient;
  }
});
