import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { tempDir } from '../core/testing.ts';
import { groupAlive, killGroup, startSetup, waitForFile } from './testing/process.ts';
import { tree, world } from './testing/world.ts';

test('[CLI-008] a stale lock from a killed setup names the exact lock', async () => {
  const w = world();
  writeFileSync(join(w.codexHome, 'config.toml'), 'model = "gpt-6-luna"\n');
  const pause = join(tempDir('pause'), 'trust');
  const install = startSetup(['install', '--trust-hooks'], { cwd: w.project, env: { ...w.env, FAKE_CODEX_TRUST_PAUSE: pause } });
  try { await waitForFile(pause); } finally { killGroup(install.pid); }
  assert.equal((await install.done).signal, 'SIGKILL');
  for (const until = Date.now() + 5_000; groupAlive(install.pid);) {
    assert.ok(Date.now() < until, 'no setup process or fake app-server survives the kill');
    await delay(20);
  }

  const lock = join(w.stateDir, 'setup', 'codex.setup.lock');
  assert.equal(existsSync(lock), true);
  const project = tree(w.project);
  for (const command of ['enable', 'disable', 'install', 'uninstall']) {
    const r = w.ce([command]);
    assert.notEqual(r.status, 0, `${command} ran past the stale lock`);
    assert.ok(r.stderr.includes(lock), `${command} names ${lock}:\n${r.stderr}`);
    assert.match(r.stderr, /verify no setup process is running, including a runner plugin command it started, before removing this lock/);
  }
  assert.deepEqual(tree(w.project), project);
  assert.equal(w.ce(['status', '--json']).status, 0, 'status takes no lock');
});
