// A setup process killed mid-run skips every in-process rollback. The next runs must finish, undo or
// refuse the interrupted operation, never adopt half-applied runner config as a new baseline.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { tempDir } from '../core/testing.ts';
import { killGroup, startBounded } from '../adapters/codex/testing/hook-process.ts';
import { CLI, world } from './testing/world.ts';

const CODEX_CONFIG = '# my codex config\nmodel = "gpt-6-luna"\n';

test('[LIFE-015] SIGKILL during Codex install never becomes a silent baseline', {
  todo: 'setup defect, routed to the parent (LIFE-015 is also in U08 and U09): the next install snapshots the half-applied config.toml as its baseline, and uninstall reports it restored byte for byte while [marketplaces.context-engine] remains',
}, async () => {
  const w = world();
  const config = join(w.codexHome, 'config.toml');
  writeFileSync(config, CODEX_CONFIG);
  const pause = join(tempDir('pause'), 'plugin-add');
  const install = startBounded([process.execPath, CLI, 'install', '--codex'], { cwd: w.project, env: { ...process.env, ...w.env, FAKE_CODEX_PAUSE: pause }, input: '', timeoutMs: 60_000 });
  try {
    for (const until = Date.now() + 20_000; !existsSync(pause);) { assert.ok(Date.now() < until, 'install reached plugin add'); await delay(20); }
  } finally { killGroup(install.pid); }
  assert.equal((await install.done).signal, 'SIGKILL');

  const lock = join(w.stateDir, 'setup', 'codex.setup.lock');
  const blocked = w.ce(['enable']);
  assert.notEqual(blocked.status, 0);
  assert.ok(blocked.stderr.includes(lock), blocked.stderr);
  rmSync(lock);

  const again = w.ce(['install', '--codex']);
  if (again.status !== 0) {
    assert.ok(again.stderr.includes(join(w.stateDir, 'setup', 'backups')), `a refusal names the orphan snapshot: ${again.stderr}`);
    return;
  }
  const removed = w.ce(['uninstall', '--codex']);
  assert.equal(removed.status, 0, removed.stdout + removed.stderr);
  assert.equal(readFileSync(config, 'utf8'), CODEX_CONFIG, `config.toml returns to its pre-kill bytes. Uninstall said:\n${removed.stdout}`);
  assert.equal(existsSync(join(w.stateDir, 'setup', 'codex-marketplace')), false);
});
