// The suites make thousands of fixtures. Where the temp directory is RAM-backed, leftovers fill it,
// so a test file must leave nothing there when its process exits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './testing.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

// Uses every helper that makes a temp directory, including a CLI run with an owner process, and
// renames one directory the way the parent-swap tests do.
const PROBE = `
import { renameSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, ownerProcess, startCli, stopGroup, tempDir } from ${JSON.stringify(join(here, 'testing.ts'))};
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

test('[PERF-012] a test file run leaves nothing in the temp directory', { timeout: 60_000 }, () => {
  const root = tempDir('hygiene');
  const tmp = join(root, 'tmp');
  mkdirSync(tmp);
  const probe = join(root, 'probe.test.mjs');
  writeFileSync(probe, PROBE);
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: tmp };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', join(here, 'isolation.test.ts'), probe], { env, encoding: 'utf8', timeout: 50_000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(readdirSync(tmp), [], 'the temp directory is empty after the run');
});
