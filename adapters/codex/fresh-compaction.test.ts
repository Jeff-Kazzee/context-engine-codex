import './testing/private-tmp.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openSession, readWorkingContext } from '../../core/index.ts';
import { pendingRestoreNotices } from '../../core/restore-notices.ts';
import { layout } from '../../core/store.ts';
import { enabledFixture, newContext, preCompact, runHook, toolUse } from './testing/hook-process.ts';

function fresh() {
  const f = enabledFixture();
  const opened = openSession({ ...f, sessionId: 'S1', runner: 'codex', hardLimit: 400000 });
  assert.equal(opened.status, 'open');
  const s = opened.session;
  s.record([{ role: 'user', text: 'FRESH_CURRENT_TASK' }]);
  rmSync(s.workingContextPath);
  return { f, s, log: layout(f.projectRoot, 'S1', f.stateDir).events };
}
type Fresh = ReturnType<typeof fresh>;
function refused(output: string): void {
  const result = JSON.parse(output || '{}');
  assert.equal(result.continue, false, 'fresh restored state must be read before compaction');
  assert.match(result.stopReason, /read.*every part|read.*current/i);
}
async function read(t: Fresh, partial = false): Promise<void> {
  const value = readWorkingContext({ ...t.f, sessionId: 'S1' });
  assert.equal(value.parts, 1);
  const response = partial ? value.text.slice(0, 5) : value.text;
  const result = await runHook(t.f, 'S1', toolUse('Bash', { command: `context-engine read --session S1 --sha ${value.sha}` }, response, 'current-read'));
  assert.equal(result.status, 0, result.stderr);
}

test('fresh PreCompact restoration refuses before any restored-state read', async () => {
  const t = fresh();
  try {
    const result = await runHook(t.f, 'S1', preCompact);
    assert.equal(result.status, 0, result.stderr);
    refused(result.stdout);
    assert.match(readFileSync(t.s.workingContextPath, 'utf8'), /FRESH_CURRENT_TASK/);
    assert.equal(pendingRestoreNotices(t.log).size, 1);
  } finally { t.s.close(); }
});

test('fresh PreCompact retry without a read remains refused', async () => {
  const t = fresh();
  try {
    await runHook(t.f, 'S1', preCompact);
    const ids = [...pendingRestoreNotices(t.log).keys()];
    refused((await runHook(t.f, 'S1', preCompact)).stdout);
    assert.deepEqual([...pendingRestoreNotices(t.log).keys()], ids);
  } finally { t.s.close(); }
});

test('fresh PreCompact retry succeeds after full current read without confirming IDs', async () => {
  const t = fresh();
  try {
    await runHook(t.f, 'S1', preCompact);
    const ids = [...pendingRestoreNotices(t.log).keys()];
    await read(t);
    const result = await runHook(t.f, 'S1', preCompact);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.deepEqual([...pendingRestoreNotices(t.log).keys()], ids);
  } finally { t.s.close(); }
});

test('fresh PreCompact partial read does not clear its durable barrier', async () => {
  const t = fresh();
  try {
    await runHook(t.f, 'S1', preCompact);
    await read(t, true);
    refused((await runHook(t.f, 'S1', preCompact)).stdout);
  } finally { t.s.close(); }
});

test('fresh PreCompact stale read does not clear its durable barrier', async () => {
  const t = fresh();
  try {
    await runHook(t.f, 'S1', preCompact);
    await read(t);
    writeFileSync(t.s.workingContextPath, readFileSync(t.s.workingContextPath, 'utf8') + '\nNEW_CURRENT_DETAIL');
    t.s.sync();
    refused((await runHook(t.f, 'S1', preCompact)).stdout);
  } finally { t.s.close(); }
});

test('fresh PreCompact another identical-byte restore invalidates the earlier read', async () => {
  const t = fresh();
  try {
    await runHook(t.f, 'S1', preCompact);
    await read(t);
    rmSync(t.s.workingContextPath);
    t.s.sync();
    assert.equal(pendingRestoreNotices(t.log).size, 2);
    refused((await runHook(t.f, 'S1', preCompact)).stdout);
  } finally { t.s.close(); }
});

test('fresh PreCompact killed after sync cannot bypass the restored-state read', async () => {
  const t = fresh();
  try {
    const preload = join(t.f.projectRoot, 'kill-after-compact-sync.mjs');
    const fired = join(t.f.projectRoot, 'compact-sync-fired');
    writeFileSync(preload, `import fs from 'node:fs';import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
if(process.argv[1]?.endsWith('/codex-hook.ts')){const original=cp.spawnSync;cp.spawnSync=function(file,args,...rest){const result=original.call(this,file,args,...rest);if(args?.[1]==='sync'){fs.writeFileSync(${JSON.stringify(fired)},'fired');process.kill(process.pid,'SIGKILL');}return result;};syncBuiltinESMExports();}`);
    const killed = await runHook(t.f, 'S1', preCompact, { NODE_OPTIONS: `--import=${preload}` });
    assert.notEqual(killed.status, 0);
    assert.ok(existsSync(fired));
    assert.equal(pendingRestoreNotices(t.log).size, 1);
    refused((await runHook(t.f, 'S1', preCompact)).stdout);
    await read(t);
    assert.equal((await runHook(t.f, 'S1', preCompact)).stdout, '');
  } finally { t.s.close(); }
});

test('fresh PreCompact read can complete through the agent reset before its native callback', async () => {
  const t = fresh();
  try {
    await runHook(t.f, 'S1', preCompact);
    await read(t);
    assert.equal((await runHook(t.f, 'S1', newContext)).stdout, '');
    const reset = await runHook(t.f, 'S1', toolUse('new_context', {}, 'A new context window will start.', 'reset-after-read'));
    assert.equal(reset.status, 0, reset.stderr);
    assert.equal((await runHook(t.f, 'S1', preCompact)).stdout, '');
    assert.equal(pendingRestoreNotices(t.log).size, 1);
  } finally { t.s.close(); }
});

test('fresh PreCompact uncertain sync then missing executable retains its read barrier', async () => {
  const t = fresh();
  try {
    const preload = join(t.f.projectRoot, 'lost-sync-then-enoent.mjs');
    const trace = join(t.f.projectRoot, 'compact-fault-trace.json');
    writeFileSync(preload, `import fs from 'node:fs';import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
if(process.argv[1]?.endsWith('/codex-hook.ts')){const original=cp.spawnSync,calls=[];cp.spawnSync=function(file,args,...rest){calls.push(args?.[1]);fs.writeFileSync(${JSON.stringify(trace)},JSON.stringify(calls));if(calls.length===1){const actual=original.call(this,file,args,...rest);if(actual.status!==0)throw new Error('fixture sync did not finish');return {status:null,signal:'SIGTERM',stdout:'',stderr:'',error:Object.assign(new Error('lost sync result'),{code:'ETIMEDOUT'})};}return {status:null,signal:null,stdout:'',stderr:'',error:Object.assign(new Error('executable disappeared'),{code:'ENOENT'})};};syncBuiltinESMExports();}`);
    const result = await runHook(t.f, 'S1', preCompact, { NODE_OPTIONS: `--import=${preload}` });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(trace, 'utf8')), ['sync', 'record', 'sync']);
    assert.match(readFileSync(t.s.workingContextPath, 'utf8'), /FRESH_CURRENT_TASK/);
    const ids = [...pendingRestoreNotices(t.log).keys()];
    assert.equal(ids.length, 1);
    refused(result.stdout);
    assert.ok(existsSync(join(layout(t.f.projectRoot, 'S1', t.f.stateDir).stateDir, 'codex-precompact-read.json')));
    refused((await runHook(t.f, 'S1', preCompact)).stdout);
    assert.deepEqual([...pendingRestoreNotices(t.log).keys()], ids);
    await read(t);
    assert.equal((await runHook(t.f, 'S1', preCompact)).stdout, '');
    assert.deepEqual([...pendingRestoreNotices(t.log).keys()], ids);
  } finally { t.s.close(); }
});

for (const format of ['plain', 'framed', 'raw'] as const) test(`restore read payload proof distinguishes ${format} header text`, async () => {
  const f = enabledFixture();
  const opened = openSession({ ...f, sessionId: 'S1', runner: 'codex', hardLimit: 400000 });
  assert.equal(opened.status, 'open');
  const s = opened.session;
  try {
    s.record([{ role: 'user', text: 'INITIAL_TASK' }]);
    const text = format === 'framed' ? 'framed Working Context v1' : 'This is the last part.';
    writeFileSync(s.workingContextPath, text);
    s.sync();
    assert.equal(readFileSync(s.workingContextPath, 'utf8'), text);
    rmSync(s.workingContextPath);
    refused((await runHook(f, 'S1', preCompact)).stdout);
    const log = layout(f.projectRoot, 'S1', f.stateDir).events;
    const ids = [...pendingRestoreNotices(log).keys()];
    if (format !== 'raw') {
      const value = readWorkingContext({ ...f, sessionId: 'S1', framed: format === 'framed' });
      const header = value.text.split('\n')[0]!;
      assert.ok(header.includes(text), 'fixture content appears in the CLI header');
      const command = `context-engine read --session S1 --sha ${value.sha}${format === 'framed' ? ' --framed' : ''}`;
      const truncated = await runHook(f, 'S1', toolUse('Bash', { command }, header, 'header-only'));
      assert.equal(truncated.status, 0, truncated.stderr);
      refused((await runHook(f, 'S1', preCompact)).stdout);
      const full = await runHook(f, 'S1', toolUse('Bash', { command }, value.text, 'complete-payload'));
      assert.equal(full.status, 0, full.stderr);
    } else {
      const raw = await runHook(f, 'S1', toolUse('Bash', { command: `cat ${s.workingContextPath}` }, text, 'raw-file'));
      assert.equal(raw.status, 0, raw.stderr);
    }
    assert.equal((await runHook(f, 'S1', preCompact)).stdout, '');
    assert.deepEqual([...pendingRestoreNotices(log).keys()], ids);
  } finally { s.close(); }
});
