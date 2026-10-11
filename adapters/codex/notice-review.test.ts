import './testing/private-tmp.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { layout } from '../../core/store.ts';
import { CLI, enabledFixture, hookEnv, preCompact, prompt, runHook, startBounded, toolUse, type Fixture } from './testing/hook-process.ts';

const SID = '01a10d16-4780-71c2-803c-80339e0708d7';
const wcPath = (f: Fixture) => join(f.projectRoot, '.context-engine', SID, 'context.md');
const noticePath = (f: Fixture) => join(layout(f.projectRoot, SID, f.stateDir).stateDir, 'codex-read-notice.json');
const NOTICE = /revision (\d+) was validated \(sha256 ([0-9a-f]{64})\)/;

test('a staggered parallel tool refreshes an unread notice until read-back', async () => {
  const f = enabledFixture();
  assert.equal((await runHook(f, SID, prompt('ACTIVE_TASK'))).status, 0);
  writeFileSync(wcPath(f), `${readFileSync(wcPath(f), 'utf8').trimEnd()}\nEDIT_SENTINEL\n`);
  const edit = await runHook(f, SID, toolUse('Bash', { command: `sed -i 's/x/y/' .context-engine/${SID}/context.md` }, '', 'call_edit'));
  assert.equal(edit.status, 0, edit.stderr);
  const slow = await runHook(f, SID, toolUse('Bash', { command: 'make' }, 'SLOW_TOOL_OUTPUT', 'call_slow'));
  assert.equal(slow.status, 0, slow.stderr);
  const notice = NOTICE.exec(String(JSON.parse(slow.stdout).hookSpecificOutput?.additionalContext));
  assert.ok(notice, 'the later tool delivers a current notice');
  const read = await startBounded([process.execPath, CLI, 'read', '--session', SID, '--sha', notice[2]!], {
    cwd: f.projectRoot, env: hookEnv(f), input: '', timeoutMs: 30_000,
  }).done;
  assert.equal(read.status, 0, read.stderr);
  assert.match(read.stdout, /EDIT_SENTINEL/);
  assert.match(read.stdout, /SLOW_TOOL_OUTPUT/);
  const acknowledged = await runHook(f, SID, toolUse('Bash', { command: `context-engine read --session ${SID} --sha ${notice[2]}` }, read.stdout, 'call_read'));
  assert.equal(acknowledged.status, 0, acknowledged.stderr);
  const next = await runHook(f, SID, toolUse('Bash', { command: 'ls' }, 'AFTER_READ', 'call_next'));
  assert.equal(next.status, 0, next.stderr);
  assert.doesNotMatch(next.stdout, /was validated/);
});

test('the hook reads only the Event Log tail after its first scan', async () => {
  const f = enabledFixture();
  assert.equal((await runHook(f, SID, prompt('ACTIVE_TASK'))).status, 0);
  const preload = join(f.projectRoot, 'count-log-reads.mjs');
  const count = join(f.projectRoot, 'log-read-bytes.txt');
  writeFileSync(preload, `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
if (process.argv[1]?.endsWith('/codex-hook.ts')) {
  let total = 0;
  const read = fs.readSync;
  fs.readSync = function (fd, ...args) {
    const size = read.call(this, fd, ...args);
    if (fs.readlinkSync('/proc/self/fd/' + fd).endsWith('/events.jsonl')) total += size;
    return size;
  };
  syncBuiltinESMExports();
  process.on('exit', () => fs.writeFileSync(process.env.CE_TEST_READ_BYTES, String(total)));
}
`);
  for (let i = 0; i < 2; i++) {
    const run = await runHook(f, SID, toolUse('Bash', { command: `generate ${i}` }, 'x'.repeat(160_000), `call_large_${i}`));
    assert.equal(run.status, 0, run.stderr);
  }
  const size = statSync(layout(f.projectRoot, SID, f.stateDir).events).size;
  assert.ok(size > 320_000, 'the history exceeds the tail-read budget');
  const measured = async (id: string) => {
    const run = await runHook(f, SID, toolUse('Bash', { command: 'ls' }, 'SMALL_OUTPUT', id), {
      NODE_OPTIONS: `--import=${preload}`, CE_TEST_READ_BYTES: count,
    });
    assert.equal(run.status, 0, run.stderr);
    assert.doesNotMatch(run.stdout, /"continue":false/);
    return Number(readFileSync(count, 'utf8'));
  };
  const steady = await measured('call_steady');
  assert.ok(steady > 0 && steady < 65_536, `steady hook read ${steady} bytes`);
  const state = JSON.parse(readFileSync(noticePath(f), 'utf8'));
  delete state.logOffset;
  writeFileSync(noticePath(f), JSON.stringify(state));
  assert.ok(await measured('call_upgrade') >= size, 'an older state scans existing history once');
  const resumed = await measured('call_resumed');
  assert.ok(resumed > 0 && resumed < 65_536, `following hook read ${resumed} bytes`);
});

test('PreCompact emits one refusal when its final completion check fails', async () => {
  const f = enabledFixture();
  assert.equal((await runHook(f, SID, prompt('ACTIVE_TASK'))).status, 0);
  writeFileSync(wcPath(f), '[[CTX_TURN 1 role=user]]\n');
  const preload = join(f.projectRoot, 'fail-final-debt-check.mjs');
  writeFileSync(preload, `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
if (process.argv[1]?.endsWith('/codex-hook.ts')) {
  let scans = 0;
  const readdir = fs.readdirSync;
  fs.readdirSync = function (path, ...args) {
    if (String(path).startsWith('/proc/self/fd/') && fs.readlinkSync(path) === process.env.CE_TEST_SESSION_STATE && ++scans === 2) {
      throw new Error('FINAL_DEBT_CHECK_FAULT');
    }
    return readdir.call(this, path, ...args);
  };
  syncBuiltinESMExports();
}
`);
  const result = await runHook(f, SID, preCompact, {
    NODE_OPTIONS: `--import=${preload}`, CE_TEST_SESSION_STATE: layout(f.projectRoot, SID, f.stateDir).stateDir,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /FINAL_DEBT_CHECK_FAULT/, 'the final check must fail');
  assert.equal(JSON.parse(result.stdout).continue, false, 'the entire output is one valid refusal');
});

test('PreCompact preserves the reset marker and edit notice after a failed sync', async () => {
  const f = enabledFixture();
  assert.equal((await runHook(f, SID, prompt('ACTIVE_TASK'))).status, 0);
  writeFileSync(wcPath(f), `${readFileSync(wcPath(f), 'utf8').trimEnd()}\nCOMPACTION_EDIT\n`);
  const wrapper = join(f.projectRoot, 'fail-sync.mjs');
  writeFileSync(wrapper, `import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
if (process.argv[2] === 'sync') { process.stderr.write('SYNC_FAULT'); process.exit(1); }
const run = spawnSync(process.execPath, [${JSON.stringify(CLI)}, ...process.argv.slice(2)], { input: readFileSync(0), encoding: 'utf8' });
process.stdout.write(run.stdout);
process.stderr.write(run.stderr);
process.exit(run.status ?? 1);
`);
  const result = await runHook(f, SID, preCompact, { CONTEXT_ENGINE_CLI: wrapper });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /SYNC_FAULT/);
  assert.equal(result.stdout, '');
  assert.match(readFileSync(wcPath(f), 'utf8'), /Context window reset/);
  const next = await runHook(f, SID, prompt('NEXT_REQUEST'));
  assert.equal(next.status, 0, next.stderr);
  assert.match(next.stdout, /was validated/);
  assert.match(readFileSync(wcPath(f), 'utf8'), /COMPACTION_EDIT/);
});
