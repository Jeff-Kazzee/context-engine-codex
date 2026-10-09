// The U02 test files keep every temporary directory under a private root that they remove when they
// finish (testing/private-tmp.ts). A run inside an empty TMPDIR must leave that directory empty.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startBounded } from './testing/hook-process.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const FILES = ['adapters/codex/activation.test.ts', 'adapters/codex/hook-processes.test.ts', 'adapters/codex/turn-loop/cli.test.ts', 'setup/hook-command.test.ts', 'setup/kill.test.ts'];
/** One quick test per temp helper: core fixtures, the setup world, a checkout copy, the fake app-server and a killed install. */
const PATTERN = '\\[(CORE-036|CDX-002|CDX-015|CDX-017|LIFE-015)\\]';

test('a run of the U02 Codex test files leaves no new entries in the temporary directory', async () => {
  const leak = mkdtempSync(join(tmpdir(), 'ce-u02-leak-'));
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: leak, NODE_OPTIONS: '' };
    delete env.NODE_TEST_CONTEXT;
    const run = await startBounded([process.execPath, '--test', '--test-concurrency=1', `--test-name-pattern=${PATTERN}`, ...FILES], { cwd: ROOT, env, input: '', timeoutMs: 180_000 }).done;
    assert.equal(run.status, 0, run.stdout.slice(-3000) + run.stderr);
    assert.match(run.stdout, /(# pass|ℹ pass) (1[5-9]|[2-9]\d)/, 'the selected tests ran');
    assert.deepEqual(readdirSync(leak), []);
  } finally { rmSync(leak, { recursive: true, force: true }); }
});
