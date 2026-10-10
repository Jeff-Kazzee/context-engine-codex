// A setup process killed mid-run skips every in-process rollback. The next runs must finish, undo or
// refuse the interrupted operation, and never adopt half-applied runner config as a new baseline.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../core/testing.ts';
import { killGroup, startSetup, waitForFile } from './testing/process.ts';
import { world } from './testing/world.ts';

const CODEX_CONFIG = '# my codex config\nmodel = "gpt-6-luna"\n';

test('[LIFE-015] SIGKILL during Codex install never becomes a silent baseline', async () => {
  const w = world();
  const config = join(w.codexHome, 'config.toml');
  writeFileSync(config, CODEX_CONFIG);
  const pause = join(tempDir('pause'), 'plugin-add');
  const install = startSetup(['install'], { cwd: w.project, env: { ...w.env, FAKE_CODEX_PAUSE: pause } });
  try { await waitForFile(pause); } finally { killGroup(install.pid); }
  assert.equal((await install.done).signal, 'SIGKILL');
  assert.match(readFileSync(config, 'utf8'), /\[marketplaces\.context-engine\]/, 'the kill left the marketplace half-applied');

  const lock = join(w.stateDir, 'setup', 'codex.setup.lock');
  const blocked = w.ce(['enable']);
  assert.notEqual(blocked.status, 0);
  assert.ok(blocked.stderr.includes(lock), blocked.stderr);
  rmSync(lock);

  const again = w.ce(['install']);
  if (again.status !== 0) {
    assert.ok(again.stderr.includes(join(w.stateDir, 'setup', 'backups')), `a refusal names the orphan snapshot:\n${again.stderr}`);
    return;
  }
  const removed = w.ce(['uninstall']);
  assert.equal(removed.status, 0, removed.stdout + removed.stderr);
  assert.equal(readFileSync(config, 'utf8'), CODEX_CONFIG, `config.toml returns to its pre-kill bytes. Uninstall said:\n${removed.stdout}`);
  assert.equal(existsSync(join(w.stateDir, 'setup', 'codex-marketplace')), false);
  assert.equal(existsSync(join(w.codexHome, 'plugins', 'cache', 'context-engine')), false);
});

test('[LIFE-015] a refused undo names the file, the record and the snapshot without a stack trace', async () => {
  const w = world();
  const config = join(w.codexHome, 'config.toml');
  writeFileSync(config, CODEX_CONFIG);
  const pause = join(tempDir('pause'), 'plugin-add');
  const install = startSetup(['install'], { cwd: w.project, env: { ...w.env, FAKE_CODEX_PAUSE: pause } });
  try { await waitForFile(pause); } finally { killGroup(install.pid); }
  assert.equal((await install.done).signal, 'SIGKILL');
  rmSync(join(w.stateDir, 'setup', 'codex.setup.lock'));
  const pending = join(w.stateDir, 'setup', 'codex.pending.json');
  const backups = join(w.stateDir, 'setup', 'backups');

  // A tracked file that no longer parses blocks the undo. The refusal names it and what to repair.
  writeFileSync(config, `${readFileSync(config, 'utf8')}bad = "unterminated\n`);
  for (const command of ['install', 'uninstall']) {
    const r = w.ce([command]);
    assert.notEqual(r.status, 0, `${command} refuses an undo over unparsable TOML`);
    for (const name of [config, pending, backups]) assert.ok(r.stderr.includes(name), `${command} names ${name}:\n${r.stderr}`);
    assert.doesNotMatch(r.stderr, /^\s+at /m, `${command} prints no stack trace`);
  }

  // A record that is not JSON cannot say what to undo. Every command names it.
  writeFileSync(pending, '{"dir": ');
  for (const command of ['install', 'uninstall', 'enable', 'status']) {
    const r = w.ce([command]);
    assert.notEqual(r.status, 0, `${command} refuses a corrupt interrupted install record`);
    assert.ok(r.stderr.includes(pending), `${command} names ${pending}:\n${r.stderr}`);
    assert.doesNotMatch(r.stderr, /^\s+at /m, `${command} prints no stack trace`);
  }
});

test('[LIFE-015] enable and status refuse until an interrupted install is undone', async () => {
  const w = world();
  const config = join(w.codexHome, 'config.toml');
  writeFileSync(config, CODEX_CONFIG);
  const pause = join(tempDir('pause'), 'plugin-add');
  const install = startSetup(['install'], { cwd: w.project, env: { ...w.env, FAKE_CODEX_PAUSE: pause } });
  try { await waitForFile(pause); } finally { killGroup(install.pid); }
  assert.equal((await install.done).signal, 'SIGKILL');
  rmSync(join(w.stateDir, 'setup', 'codex.setup.lock'));
  const pending = join(w.stateDir, 'setup', 'codex.pending.json');
  assert.ok(existsSync(pending), 'the kill left the interrupted install record');

  for (const args of [['enable'], ['status'], ['status', '--json']]) {
    const r = w.ce(args);
    assert.notEqual(r.status, 0, `${args.join(' ')} refuses while the interrupted install is not undone. It said:\n${r.stdout}`);
    assert.ok(r.stderr.includes(pending), `${args.join(' ')} names ${pending}:\n${r.stderr}`);
    for (const recovery of ['context-engine-codex install', 'context-engine-codex uninstall']) assert.ok(r.stderr.includes(recovery), `${args.join(' ')} names \`${recovery}\`:\n${r.stderr}`);
  }
  assert.equal(existsSync(join(w.stateDir, 'participation')), false, 'the refused enable wrote no participation record');

  const undo = w.ce(['uninstall']);
  assert.equal(undo.status, 0, undo.stdout + undo.stderr);
  assert.equal(readFileSync(config, 'utf8'), CODEX_CONFIG);
  const enabled = w.ce(['enable']);
  assert.equal(enabled.status, 0, enabled.stderr);
  assert.equal(w.ce(['status']).status, 0, 'status works again after the undo');
});
