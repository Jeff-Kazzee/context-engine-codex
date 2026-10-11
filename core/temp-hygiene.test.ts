// The suites make thousands of fixtures. Where the temp directory is RAM-backed, leftovers fill it,
// so a test process must leave nothing there when it exits or is stopped with SIGTERM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir, waitForFile } from './testing.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const helpers = JSON.stringify(join(here, 'testing.ts'));

// Uses every helper that makes a temp directory, including a CLI run with an owner process, and
// renames one directory the way the parent-swap tests do.
const PROBE = `
import { renameSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, ownerProcess, startCli, stopGroup, tempDir } from ${helpers};
test('helpers', async () => {
  const f = fixture();
  const moved = tempDir('probe');
  renameSync(moved, moved + '-held');
  const owner = ownerProcess();
  try {
    const r = await startCli(f, ['record', '--session', 'S1', '--runner', 'test', '--hard-limit', '1000', '--owner-pid', String(owner.pid)], { input: JSON.stringify({ role: 'user', text: 'probe' }) }).done;
    assert.equal(r.code, 0, r.stdout + r.stderr);
  } finally {
    await stopGroup(owner);
  }
});
`;

// Makes a fixture, says so, then waits to be stopped.
const STOPPED = `
import { writeFileSync } from 'node:fs';
import { fixture } from ${helpers};
fixture();
writeFileSync(process.argv[1], '');
setTimeout(() => {}, 60_000);
`;

function privateTemp(): { tmp: string; root: string; env: NodeJS.ProcessEnv } {
  const root = tempDir('hygiene');
  const tmp = join(root, 'tmp');
  mkdirSync(tmp);
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: tmp };
  delete env.NODE_TEST_CONTEXT;
  return { tmp, root, env };
}

test('[PERF-012] a multi-file test run leaves nothing in the temp directory', { timeout: 60_000 }, () => {
  const { tmp, root, env } = privateTemp();
  const probe = join(root, 'probe.test.mjs');
  writeFileSync(probe, PROBE);
  const files = ['isolation.test.ts', 'wave7-regressions.test.ts', 'wave9-regressions.test.ts'].map((name) => join(here, name));
  const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files, probe], { env, encoding: 'utf8', timeout: 50_000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(readdirSync(tmp), [], 'the temp directory is empty after the run');
});

test('[PERF-012] a test process stopped with SIGTERM leaves nothing in the temp directory', { timeout: 30_000 }, async () => {
  const { tmp, root, env } = privateTemp();
  const ready = join(root, 'ready');
  const child = spawn(process.execPath, ['--input-type=module', '-e', STOPPED, ready], { env, stdio: 'ignore' });
  try {
    await waitForFile(ready);
    assert.notDeepEqual(readdirSync(tmp), [], 'the fixture is in place');
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    assert.deepEqual((await exited)[1], 'SIGTERM', 'the process still dies of the signal');
    assert.deepEqual(readdirSync(tmp), [], 'the temp directory is empty after SIGTERM');
  } finally {
    child.kill('SIGKILL');
  }
});
