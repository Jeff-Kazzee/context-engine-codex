import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('ordinary Linux skips absent PowerShell but preserves a launched fixture failure', {
  skip: process.platform !== 'linux' && 'Linux optional-PowerShell behavior.',
}, (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'ce-pwsh-check-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const env = { ...process.env, PATH: directory };
  delete env.CE_CONTAINER_CI;
  delete env.NODE_TEST_CONTEXT;
  const run = () => spawnSync(process.execPath, [
    '--test', '--test-reporter=tap',
    fileURLToPath(new URL('./action-runtime.test.mjs', import.meta.url)),
  ], { env, encoding: 'utf8', timeout: 10000, maxBuffer: 65536 });

  const absent = run();
  assert.equal(absent.status, 0, absent.stderr || absent.stdout || String(absent.error));
  assert.match(absent.stdout, /# SKIP PowerShell is unavailable on this Linux host/);
  assert.match(absent.stdout, /# pass 2\b/);

  writeFileSync(join(directory, 'pwsh'), '#!/bin/sh\nexit 7\n', { mode: 0o755 });
  const failed = run();
  assert.equal(failed.status, 1, failed.stderr || failed.stdout || String(failed.error));
  assert.match(failed.stdout, /actual: 7\b/);
  assert.doesNotMatch(failed.stdout, /# SKIP PowerShell is unavailable/);
});
