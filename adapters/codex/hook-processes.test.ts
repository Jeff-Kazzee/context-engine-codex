// Codex hook processes under host conditions: fail-closed paths and their time bounds, runner
// restarts and kills between hooks, IPC overflow, and state that changes under a live session.
// Every hook runs as its own bounded process with the event JSON on stdin, as Codex runs it.
import './testing/private-tmp.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { tempDir } from '../../core/testing.ts';
import { setParticipation } from '../../core/index.ts';
import { layout, sha } from '../../core/store.ts';
import { world } from '../../setup/testing/world.ts';
import {
  CLI, denial, enabledFixture, event, HOOK, headRevision, hookEnv, killGroup, loggedEvents, newContext, pendingMarkers, preCompact, prompt,
  runHook, runnerResults, sessionBytes, startBounded, startRunner, stop, stoppedContinuation, toolUse, type Fixture, type Run,
} from './testing/hook-process.ts';

const SID = '01a10d16-4780-71c2-803c-80339e0708d3';
const wcPath = (f: Fixture, sid = SID) => join(f.projectRoot, '.context-engine', sid, 'context.md');

const FIVE_EVENTS = [
  ['UserPromptSubmit', prompt('SYNTHETIC_PROMPT')],
  ['PostToolUse', toolUse('Bash', { command: 'ls' }, 'SYNTHETIC_OUTPUT', 'call_five')],
  ['Stop', stop('SYNTHETIC_REPLY')],
  ['new_context', newContext],
  ['PreCompact', preCompact],
] as const;

/** The documented refusal for an enabled project whose core cannot be used. */
function assertRefused(name: string, run: Run): void {
  assert.equal(run.status, 0, `${name}: ${run.stderr}`);
  if (name === 'new_context') assert.match(denial(run), /context window was NOT reset/, name);
  else assert.ok(stoppedContinuation(run), `${name} stops continuation: ${run.stdout}`);
}

function throwingCheckout(): string {
  const checkout = tempDir('checkout');
  mkdirSync(join(checkout, 'core'));
  writeFileSync(join(checkout, 'core', 'cli.ts'), '');
  writeFileSync(join(checkout, 'core', 'index.ts'), "throw new Error('synthetic module failure');\n");
  return join(checkout, 'core', 'cli.ts');
}

test('[CDX-014] each fail-closed hook refuses within one second when the checkout core throws on load', async () => {
  const f = enabledFixture();
  const broken = { CONTEXT_ENGINE_CLI: throwingCheckout() };
  for (const [name, fields] of FIVE_EVENTS) {
    const run = await runHook(f, SID, fields, broken, 10_000);
    assertRefused(name, run);
    assert.match(run.stderr, /synthetic module failure/, name);
    assert.ok(run.ms < 1000, `${name} took ${Math.round(run.ms)} ms`);
  }
});

test('[PERF-010] a missing checkout fails each hook within two seconds', async () => {
  const f = enabledFixture();
  const gone = { CONTEXT_ENGINE_CLI: join(tempDir('gone'), 'core', 'cli.ts') };
  for (const [name, fields] of FIVE_EVENTS) {
    const run = await runHook(f, SID, fields, gone, 10_000);
    assertRefused(name, run);
    assert.ok(run.ms < 2000, `${name} took ${Math.round(run.ms)} ms`);
  }
});

test('[PERF-010] a stalled core CLI bounds every hook event below the 30 s hook timeout', async () => {
  const f = enabledFixture();
  const stall = join(f.projectRoot, 'stall-cli.mjs');
  writeFileSync(stall, "if(process.argv[1]?.endsWith('/core/cli.ts'))await new Promise(resolve=>setTimeout(resolve,60000));");
  // One session per event, so the events run in parallel without sharing a lease.
  const sessions = FIVE_EVENTS.map(([name]) => `stall-${name.replace('_', '-')}`);
  for (const sid of sessions) assert.equal((await runHook(f, sid, prompt('SYNTHETIC_TASK'))).status, 0);
  const before = sessions.map(sid => sessionBytes(f, sid));
  const runs = await Promise.all(FIVE_EVENTS.map(([, fields], i) => runHook(f, sessions[i]!, fields, { NODE_OPTIONS: `--import=${stall}` }, 40_000)));
  runs.forEach((run, i) => {
    const name = FIVE_EVENTS[i]![0];
    assert.equal(run.timedOut, false, name);
    assert.ok(run.ms < 26_000, `${name} took ${Math.round(run.ms)} ms`);
    assert.match(run.stderr, /ETIMEDOUT|timed out/, name);
    if (name === 'PreCompact') assert.equal(run.stdout, '', 'a valid file passes the readability fallback');
    else assertRefused(name, run);
  });
  for (const i of [3, 4]) assert.deepEqual(sessionBytes(f, sessions[i]!), before[i], `${FIVE_EVENTS[i]![0]} leaves state unchanged`);
});

test('[PERF-002] a core reply that overflows the IPC buffer fails explicitly per event', async () => {
  const f = enabledFixture();
  assert.equal((await runHook(f, SID, prompt('SYNTHETIC_TASK'))).status, 0);
  const preload = join(f.projectRoot, 'overflow-reply.mjs');
  // A stand-in for spawnSync past maxBuffer: Node reports ENOBUFS and keeps only a prefix of the reply.
  writeFileSync(preload, `import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
const reply=JSON.stringify({ok:true,revision:1,turns:[{role:'user',text:'x'.repeat(2*1024*1024)}]}).slice(0,1024*1024);
const native=cp.spawnSync;
cp.spawnSync=function(file,args,...rest){
  if(!String(args?.[0]??'').endsWith('/core/cli.ts'))return native.call(this,file,args,...rest);
  return {pid:0,output:[null,reply,''],stdout:reply,stderr:'',status:null,signal:'SIGTERM',error:Object.assign(new Error('spawnSync '+file+' ENOBUFS'),{code:'ENOBUFS'})};
};syncBuiltinESMExports();`);
  // One session per event, so one event's refusal debt cannot decide the next event's outcome.
  for (const [name, fields] of FIVE_EVENTS) {
    const sid = `overflow-${name.replace('_', '-')}`;
    assert.equal((await runHook(f, sid, prompt('SYNTHETIC_TASK'))).status, 0);
    const before = sessionBytes(f, sid);
    const run = await runHook(f, sid, fields, { NODE_OPTIONS: `--import=${preload}` });
    assert.match(run.stderr, /ENOBUFS/, name);
    if (name === 'PreCompact') assert.equal(run.stdout, '', 'the readability fallback allows a valid file');
    else assertRefused(name, run);
    if (name === 'new_context') assert.match(denial(run), /core could not be reached/);
    const after = sessionBytes(f, sid);
    assert.equal(after.events, before.events, `${name}: Event Log unchanged`);
    assert.equal(after.head, before.head, `${name}: HEAD unchanged`);
  }
});

test('[PERF-002] an escape-heavy Working Context near the hard limit passes hook IPC', async () => {
  const f = enabledFixture();
  const limits = { CONTEXT_ENGINE_HARD_LIMIT: '960000', CONTEXT_ENGINE_BUDGET_TOKENS: '1000000' };
  assert.equal((await runHook(f, SID, prompt('SYNTHETIC_TASK'), limits)).status, 0);
  const header = '[[CTX_TURN 1 role=user]]\n';
  const body = '"\\\t'.repeat(Math.floor((950_000 - header.length) / 3));
  writeFileSync(wcPath(f), header + body);
  const gate = await runHook(f, SID, newContext, limits);
  assert.equal(gate.status, 0, gate.stderr);
  assert.equal(gate.stdout, '', 'the reset is allowed');
  assert.doesNotMatch(gate.stderr, /ENOBUFS|maxBuffer|JSON|failed/);
  assert.equal(headRevision(f, SID), 2, 'the escape-heavy edit is committed');
});

test('[CDX-002] disabling a project mid-session makes the next hooks stand aside', async () => {
  const f = enabledFixture();
  assert.equal((await runHook(f, SID, prompt('SYNTHETIC_TASK'))).status, 0);
  setParticipation({ ...f, state: 'off' });
  writeFileSync(wcPath(f), '');
  const before = sessionBytes(f, SID);
  for (const fields of [toolUse('Bash', { command: 'ls' }, 'SYNTHETIC_OUTPUT'), newContext]) {
    const run = await runHook(f, SID, fields);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, '', `${fields.hook_event_name} stands aside`);
  }
  assert.deepEqual(sessionBytes(f, SID), before);
});

test('[CDX-002] unverifiable activation with live project guidance does not allow an unchecked reset', {
  todo: 'design decision for the parent: README.md documents stand-aside on unverifiable activation, while CDX-002 asks the gate to deny while the project guidance stays live',
}, async () => {
  const w = world();
  assert.equal(w.ce(['install', '--codex']).status, 0);
  const enable = w.ce(['enable']);
  assert.equal(enable.status, 0, enable.stdout + enable.stderr);
  assert.match(readFileSync(join(w.project, '.codex', 'config.toml'), 'utf8'), /developer_instructions/);
  const f = { projectRoot: w.project, stateDir: w.stateDir };
  assert.equal((await runHook(f, SID, prompt('SYNTHETIC_TASK'))).status, 0);
  chmodSync(join(w.stateDir, 'participation'), 0o755);
  try {
    writeFileSync(wcPath(f), '');
    const gate = await runHook(f, SID, newContext);
    assert.match(denial(gate), /participation/);
  } finally { chmodSync(join(w.stateDir, 'participation'), 0o700); }
});

test('[CDX-005] a legacy prompt marker preserves all session state and blocks resets', async () => {
  const f = enabledFixture();
  assert.equal((await runHook(f, SID, prompt('LEGACY_REQUEST'))).status, 0);
  const state = layout(f.projectRoot, SID, f.stateDir).stateDir;
  writeFileSync(join(state, 'codex-prompt-pending.json'), JSON.stringify({ hash: sha('LEGACY_REQUEST') }));
  const before = sessionBytes(f, SID);
  const retry = await runHook(f, SID, prompt('LEGACY_REQUEST'));
  assert.ok(stoppedContinuation(retry), retry.stdout);
  assert.match(JSON.parse(retry.stdout).stopReason, /disable Context Engine/);
  assert.match(denial(await runHook(f, SID, newContext)), /NOT reset/);
  assert.ok(stoppedContinuation(await runHook(f, SID, preCompact)));
  assert.deepEqual(sessionBytes(f, SID), before);
});

test('[REC-014] hooks after a runner restart continue the same thread session', async () => {
  const f = enabledFixture();
  const first = await startRunner(f, SID, [prompt('BEFORE_RESTART'), toolUse('Bash', { command: 'ls' }, 'TOOL_BEFORE_RESTART'), stop('REPLY_BEFORE_RESTART')]).done;
  assert.equal(first.status, 0, first.stderr);
  for (const r of runnerResults(first)) assert.equal(r.stdout.includes('"continue":false'), false, r.stdout);
  const log = readFileSync(layout(f.projectRoot, SID, f.stateDir).events);
  const lastSeq = loggedEvents(f, SID).at(-1)!.seq, revision = headRevision(f, SID);
  const second = await startRunner(f, SID, [prompt('AFTER_RESTART')]).done;
  assert.equal(second.status, 0, second.stderr);
  assert.equal(runnerResults(second)[0]!.status, 0);
  assert.doesNotMatch(runnerResults(second)[0]!.stdout, /"continue":false/);
  const resumed = loggedEvents(f, SID).at(-1)!;
  assert.deepEqual([resumed.seq, resumed.event.text], [lastSeq + 1, 'AFTER_RESTART']);
  assert.ok(headRevision(f, SID) > revision);
  assert.ok(readFileSync(layout(f.projectRoot, SID, f.stateDir).events).subarray(0, log.length).equals(log), 'the earlier Event Log is an unchanged prefix');
  assert.deepEqual(pendingMarkers(f, SID), []);
  assert.match(readFileSync(wcPath(f), 'utf8'), /BEFORE_RESTART[\s\S]*TOOL_BEFORE_RESTART[\s\S]*REPLY_BEFORE_RESTART[\s\S]*AFTER_RESTART/);
});

test('[REC-014] a runner killed mid-hook keeps its tool debt until the same tool event records once after restart', async () => {
  const f = enabledFixture();
  assert.equal((await startRunner(f, SID, [prompt('BEFORE_KILL')]).done).status, 0);
  const ready = join(f.projectRoot, 'record-paused');
  const pause = join(f.projectRoot, 'pause-record.mjs');
  writeFileSync(pause, `import fs from 'node:fs';if(process.argv[1]?.endsWith('/core/cli.ts')&&process.argv.includes('record')){fs.writeFileSync(${JSON.stringify(ready)},'ready');await new Promise(resolve=>setTimeout(resolve,30000));}`);
  const killed = toolUse('Bash', { command: 'make check' }, 'KILLED_TOOL_OUTPUT', 'call_killed');
  const revision = headRevision(f, SID);
  const runner = startRunner(f, SID, [killed], { NODE_OPTIONS: `--import=${pause}` }, 40_000);
  try {
    for (const until = Date.now() + 15_000; !existsSync(ready);) { assert.ok(Date.now() < until, 'the tool hook reached its record call'); await delay(20); }
  } finally { killGroup(runner.pid); }
  assert.equal((await runner.done).signal, 'SIGKILL');
  assert.equal(headRevision(f, SID), revision, 'nothing was committed before the kill');
  assert.equal(loggedEvents(f, SID).some(e => e.event.text.includes('KILLED_TOOL_OUTPUT')), false, 'nothing was recorded before the kill');
  assert.equal(pendingMarkers(f, SID).length, 1, 'the tool intent survives the kill');

  const resumed = await startRunner(f, SID, [prompt('AFTER_RESTART'), killed, prompt('AFTER_RESTART')]).done;
  assert.equal(resumed.status, 0, resumed.stderr);
  const [refused, retried, accepted] = runnerResults(resumed);
  assert.match(refused!.stdout, /"continue":false/, 'a new prompt waits for the unrecorded tool event');
  assert.equal(retried!.stdout, '', retried!.stderr);
  assert.doesNotMatch(accepted!.stdout, /"continue":false/);
  const texts = loggedEvents(f, SID).map(e => e.event.text);
  assert.equal(texts.filter(t => t.includes('KILLED_TOOL_OUTPUT')).length, 1, 'the tool output is recorded exactly once');
  assert.equal(texts.filter(t => t === 'AFTER_RESTART').length, 1, 'the refused prompt is recorded once, on retry');
  assert.deepEqual(pendingMarkers(f, SID), []);
});

test('[CDX-025] sub-agent events on the root session leave a pending root edit uncommitted', async () => {
  const f = enabledFixture();
  assert.equal((await runHook(f, SID, prompt('ROOT_TASK'))).status, 0);
  writeFileSync(wcPath(f), '[[CTX_TURN 1 role=user]]\nROOT_TASK\nROOT_EDIT_SENTINEL\n');
  const before = sessionBytes(f, SID);
  for (const [, fields] of FIVE_EVENTS) assert.equal((await runHook(f, SID, { ...fields, agent_id: 'a1' })).status, 0);
  assert.deepEqual(sessionBytes(f, SID), before, 'no sub-agent event syncs, records or restores the root session');
  const root = await runHook(f, SID, toolUse('Read', { file_path: 'ordinary.txt' }, 'ROOT_TOOL_OUTPUT'));
  assert.match(root.stdout, /revision 2 was validated/, 'the root edit was still pending and intact');
});

test('[CDX-009] an ordinary tool hook still delivers a pending read notice after a Stop was refused', async () => {
  const f = enabledFixture();
  assert.equal((await runHook(f, SID, prompt('ACTIVE_TASK'))).status, 0);
  writeFileSync(wcPath(f), '[[CTX_TURN 1 role=user]]\nNOTICE_EDIT_SENTINEL\n');
  const lost = await runHook(f, SID, toolUse('Write', { file_path: wcPath(f) }, 'write completed'), {}, 30_000, true);
  assert.notEqual(lost.status, 0, 'the notice never reached hook output');
  assert.match(lost.stderr, /EPIPE|broken pipe/i);
  const refused = await runHook(f, SID, stop('REPLY_WHILE_NOTICE_PENDING'));
  assert.ok(stoppedContinuation(refused), refused.stdout);
  assert.match(refused.stdout, /read notice/);
  const retry = await runHook(f, SID, toolUse('Read', { file_path: 'ordinary.txt' }, 'ORDINARY_OUTPUT'));
  assert.equal(retry.status, 0, retry.stderr);
  assert.equal(stoppedContinuation(retry), false, retry.stdout);
  assert.match(retry.stdout, /revision 2 was validated/);
  const next = await runHook(f, SID, prompt('NEXT_REQUEST'));
  assert.equal(stoppedContinuation(next), false, 'the session continues once the notice reached hook output');
  assert.match(readFileSync(wcPath(f), 'utf8'), /NOTICE_EDIT_SENTINEL[\s\S]*NEXT_REQUEST/);
});

test('[CORE-005] a PostToolUse record racing an apply_patch of the Working Context keeps the patch', {
  todo: 'core defect, routed to U01: record() materializes over an edit written after its sync, and the edit reaches no file, revision or Event Log row (core/session.ts:502-511)',
}, async () => {
  const f = enabledFixture();
  assert.equal((await runHook(f, SID, prompt('RACE_TASK'))).status, 0);
  const ready = join(f.projectRoot, 'materialize-paused'), release = join(f.projectRoot, 'materialize-release');
  const pause = join(f.projectRoot, 'pause-materialize.mjs');
  // Pauses the core CLI's record call after its sync, right before it renames the new file into place.
  writeFileSync(pause, `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
if(process.argv[1]?.endsWith('/core/cli.ts')&&process.argv.includes('record')){
  const rename=fs.renameSync;
  fs.renameSync=function(from,to){
    if(String(to).endsWith('/context.md')&&!fs.existsSync(${JSON.stringify(ready)})){
      fs.writeFileSync(${JSON.stringify(ready)},'ready');
      for(const until=Date.now()+15000;!fs.existsSync(${JSON.stringify(release)})&&Date.now()<until;)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
    }
    return rename.call(this,from,to);
  };
  syncBuiltinESMExports();
}`);
  const toolA = startBounded([process.execPath, HOOK], {
    cwd: f.projectRoot, env: hookEnv(f, { NODE_OPTIONS: `--import=${pause}` }), input: JSON.stringify(event(f, SID, toolUse('Bash', { command: 'make check' }, 'TOOL_A_OUTPUT'))), timeoutMs: 40_000,
  });
  try {
    for (const until = Date.now() + 15_000; !existsSync(ready);) { assert.ok(Date.now() < until, 'tool A reached materialization'); await delay(20); }
    writeFileSync(wcPath(f), `${readFileSync(wcPath(f), 'utf8')}\nPATCH_SENTINEL\n`);
  } finally { writeFileSync(release, 'release'); }
  const ranA = await toolA.done;
  assert.equal(ranA.status, 0, ranA.stderr);
  const toolB = await runHook(f, SID, toolUse('apply_patch', { file_path: wcPath(f) }, 'patch applied'));
  assert.equal(toolB.status, 0, toolB.stderr);
  const l = layout(f.projectRoot, SID, f.stateDir);
  const stored = [readFileSync(wcPath(f), 'utf8'), readFileSync(l.events, 'utf8'), ...readdirSync(l.revisions).map(name => readFileSync(join(l.revisions, name), 'utf8'))];
  assert.ok(stored.some(text => text.includes('PATCH_SENTINEL')), 'the patch is in the file, a revision or the Event Log');
});

test('[CDX-009] the next prompt after a refused Stop delivers the pending read notice and the session recovers', async () => {
  const f = enabledFixture();
  assert.equal((await runHook(f, SID, prompt('ACTIVE_TASK'))).status, 0);
  writeFileSync(wcPath(f), '[[CTX_TURN 1 role=user]]\nNOTICE_EDIT_SENTINEL\n');
  const lost = await runHook(f, SID, toolUse('Write', { file_path: wcPath(f) }, 'write completed'), {}, 30_000, true);
  assert.notEqual(lost.status, 0, 'the notice never reached hook output');
  assert.ok(stoppedContinuation(await runHook(f, SID, stop('REPLY_WHILE_NOTICE_PENDING'))), 'the Stop cannot hide the edit');
  const next = await runHook(f, SID, prompt('NEXT_REQUEST'));
  assert.equal(next.status, 0, next.stderr);
  assert.equal(stoppedContinuation(next), false, next.stdout);
  const notice = String(JSON.parse(next.stdout).hookSpecificOutput?.additionalContext ?? '');
  const sha = /--sha ([0-9a-f]{64})/.exec(notice)?.[1];
  assert.ok(sha, `the prompt carries a read notice: ${notice}`);
  assert.doesNotMatch(notice, /NOTICE_EDIT_SENTINEL|NEXT_REQUEST/);
  const read = await startBounded([process.execPath, CLI, 'read', '--session', SID, '--sha', sha], { cwd: f.projectRoot, env: hookEnv(f), input: '', timeoutMs: 30_000 }).done;
  assert.equal(read.status, 0, read.stdout + read.stderr);
  assert.match(read.stdout, /NOTICE_EDIT_SENTINEL[\s\S]*NEXT_REQUEST/, 'the notice names the revision the prompt committed');
  assert.equal((await runHook(f, SID, newContext)).stdout, '', 'a reset is allowed again');
  assert.equal((await runHook(f, SID, preCompact)).stdout, '', 'compaction is allowed again');
  const later = await runHook(f, SID, prompt('LATER_REQUEST'));
  assert.equal(stoppedContinuation(later), false, later.stdout);
  assert.doesNotMatch(later.stdout, /was validated/, 'the notice is delivered once');
});

/** Holds the hook's prompt lease in a separate process until `release` exists. */
function holdPromptLease(f: Fixture, sid: string) {
  const state = layout(f.projectRoot, sid, f.stateDir).stateDir;
  const ready = join(f.projectRoot, 'lease-held'), release = join(f.projectRoot, 'lease-release'), holder = join(f.projectRoot, 'lease-holder.mjs');
  const lock = new URL('../../core/lock.ts', import.meta.url).href;
  writeFileSync(holder, `import fs from 'node:fs';import {serialized} from ${JSON.stringify(lock)};serialized(${JSON.stringify(join(state, 'codex-prompt.lock'))},()=>{fs.writeFileSync(${JSON.stringify(ready)},'ready');for(const until=Date.now()+20000;!fs.existsSync(${JSON.stringify(release)})&&Date.now()<until;)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);});`);
  const holding = startBounded([process.execPath, holder], { cwd: f.projectRoot, env: hookEnv(f), input: '', timeoutMs: 40_000 });
  return { ready, release: () => writeFileSync(release, 'release'), done: holding.done };
}

async function waitUntil(check: () => boolean, what: string, ms = 15_000): Promise<void> {
  for (const until = Date.now() + ms; !check();) { assert.ok(Date.now() < until, what); await delay(10); }
}

test('[CDX-008] a Stop refused by completion debt that appears while it waits leaves no failed marker of its own', async () => {
  const f = enabledFixture();
  assert.equal((await runHook(f, SID, prompt('ACTIVE_TASK'))).status, 0);
  const state = layout(f.projectRoot, SID, f.stateDir).stateDir;
  const intents = () => readdirSync(state).filter(name => name.startsWith('codex-record-pending-'));
  const lease = holdPromptLease(f, SID);
  const planted = `codex-record-pending-${randomUUID()}.json`;
  let stopping: ReturnType<typeof startBounded> | undefined;
  try {
    await waitUntil(() => existsSync(lease.ready), 'the lease holder started');
    stopping = startBounded([process.execPath, HOOK], { cwd: f.projectRoot, env: hookEnv(f), input: JSON.stringify(event(f, SID, stop('REPLY_DURING_DEBT'))), timeoutMs: 30_000 });
    await waitUntil(() => intents().length === 1, 'the Stop published its intent and waits for the lease');
    writeFileSync(join(state, planted), JSON.stringify({ failed: true }));
  } finally { lease.release(); }
  const stopped = await stopping!.done;
  await lease.done;
  assert.ok(stoppedContinuation(stopped), stopped.stdout);
  assert.deepEqual(intents(), [planted], 'only the debt that refused the Stop remains');
});

test('[PERF-010] a Stop that waits out most of its lease and then stalls in the core answers before the 30 s hook timeout', async () => {
  const f = enabledFixture();
  assert.equal((await runHook(f, SID, prompt('ACTIVE_TASK'))).status, 0);
  const stall = join(f.projectRoot, 'stall-cli.mjs');
  writeFileSync(stall, "if(process.argv[1]?.endsWith('/core/cli.ts'))await new Promise(resolve=>setTimeout(resolve,60000));");
  const lease = holdPromptLease(f, SID);
  let stopping: ReturnType<typeof startBounded> | undefined;
  try {
    await waitUntil(() => existsSync(lease.ready), 'the lease holder started');
    stopping = startBounded([process.execPath, HOOK], { cwd: f.projectRoot, env: hookEnv(f, { NODE_OPTIONS: `--import=${stall}` }), input: JSON.stringify(event(f, SID, stop('SLOW_REPLY'))), timeoutMs: 40_000 });
    await delay(9_500);
  } finally { lease.release(); }
  const stopped = await stopping!.done;
  await lease.done;
  assert.ok(stoppedContinuation(stopped), stopped.stdout);
  assert.match(stopped.stderr, /ETIMEDOUT|timed out/);
  assert.ok(stopped.ms > 24_000, `the 9.5 s lease wait and the 15 s record timeout both elapsed: ${Math.round(stopped.ms)} ms`);
  assert.ok(stopped.ms < 29_000, `${Math.round(stopped.ms)} ms`);
});
