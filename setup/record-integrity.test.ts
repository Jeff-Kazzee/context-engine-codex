// Setup restores runner config from records it wrote earlier. A record or backup that is gone or
// foreign cannot say what to restore, so setup refuses before it changes anything.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../core/testing.ts';
import { killGroup, startSetup, waitForFile } from './testing/process.ts';
import { world } from './testing/world.ts';

const snapshotOf = (record: string) => JSON.parse(readFileSync(record, 'utf8')).dir as string;

test('[LIFE-015] a missing before backup of an interrupted install refuses the undo', async () => {
  const w = world();
  const config = join(w.codexHome, 'config.toml');
  writeFileSync(config, '');
  const pause = join(tempDir('pause'), 'plugin-add');
  const install = startSetup(['install'], { cwd: w.project, env: { ...w.env, FAKE_CODEX_PAUSE: pause } });
  try { await waitForFile(pause); } finally { killGroup(install.pid); }
  assert.equal((await install.done).signal, 'SIGKILL');
  rmSync(join(w.stateDir, 'setup', 'codex.setup.lock'));
  const pending = join(w.stateDir, 'setup', 'codex.pending.json');
  const copy = join(snapshotOf(pending), 'before', '0-config.toml');
  unlinkSync(copy);
  const afterKill = readFileSync(config, 'utf8');

  const r = w.ce(['uninstall']);
  assert.notEqual(r.status, 0, `uninstall refuses an undo without its before backup. It said:\n${r.stdout}`);
  for (const name of [copy, pending]) assert.ok(r.stderr.includes(name), `the refusal names ${name}:\n${r.stderr}`);
  assert.equal(existsSync(config) ? readFileSync(config, 'utf8') : null, afterKill, 'config.toml is left as the kill left it');
  assert.ok(existsSync(pending), 'the interrupted install record stays');
});

test('[LIFE-004] uninstall refuses an install whose before backup is missing', () => {
  const w = world();
  const config = join(w.codexHome, 'config.toml');
  writeFileSync(config, '');
  assert.equal(w.ce(['install']).status, 0);
  const pointer = join(w.stateDir, 'setup', 'codex.json');
  const copy = join(snapshotOf(pointer), 'before', '0-config.toml');
  unlinkSync(copy);
  const installed = readFileSync(config, 'utf8');

  const r = w.ce(['uninstall']);
  assert.notEqual(r.status, 0, `uninstall refuses without the before backup. It said:\n${r.stdout}`);
  assert.ok(r.stderr.includes(copy), `the refusal names ${copy}:\n${r.stderr}`);
  assert.doesNotMatch(r.stdout, /did not exist before install/);
  assert.equal(existsSync(config) ? readFileSync(config, 'utf8') : null, installed, 'config.toml is unchanged');
  assert.ok(existsSync(pointer), 'the install record stays');
});
