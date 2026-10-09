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
