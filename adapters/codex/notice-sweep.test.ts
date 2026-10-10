// Fault sweep over the read-notice state machine. Each cell starts a session in one notice state with
// a model edit at stake, runs one hook event with one fault, then runs ordinary recovery events. The
// oracle: the edit reaches applied hook output as a read notice whose digest reads back at that
// moment, ordinary tool output is in the Event Log once, and the session ends usable.
// A cell is a (start, event, fault) triple. The sweep runs every triple that PRUNED does not exclude,
// so a new cell is one line: a value on an axis, or one less PRUNED rule.
import './testing/private-tmp.ts';
import { describe, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { layout } from '../../core/store.ts';
import {
  CLI, enabledFixture, hookEnv, loggedEvents, newContext, preCompact, prompt, runHook, startBounded, stop, stoppedContinuation, toolUse, type Fixture, type Run,
} from './testing/hook-process.ts';

const SID = '01a10d16-4780-71c2-803c-80339e0708d4';
const EDIT = 'SWEEP_EDIT_SENTINEL';
const wcPath = (f: Fixture) => join(f.projectRoot, '.context-engine', SID, 'context.md');
const stateDir = (f: Fixture) => layout(f.projectRoot, SID, f.stateDir).stateDir;

type Start = 'idle' | 'checking' | 'pending';
type Kind = 'prompt' | 'own-file tool' | 'ordinary tool' | 'Stop' | 'new_context' | 'PreCompact';
type Fault = 'none' | 'state' | 'sync' | 'record' | 'output' | 'lost';

const STARTS: Start[] = ['idle', 'checking', 'pending'];
const KINDS: Kind[] = ['prompt', 'own-file tool', 'ordinary tool', 'Stop', 'new_context', 'PreCompact'];
// state: killed before the first notice state write. sync, record: killed as that core call returns.
// output: killed after the first hook output write, so Codex applies none of it. lost: stdout closed.
const FAULTS: Fault[] = ['none', 'state', 'sync', 'record', 'output', 'lost'];

/** Triples no hook version reaches, each with the reason. */
const PRUNED: Array<[Start | '*', Kind, Fault[], string]> = [
  ['*', 'own-file tool', ['record'], 'a tool that touched the managed file only syncs'],
  ['*', 'new_context', ['state', 'record'], 'the reset gate writes no notice state and never records'],
  ['*', 'Stop', ['sync'], 'a Stop makes no sync call of its own'],
  ['idle', 'ordinary tool', ['record'], 'its sync commits the unseen edit, so the tool counts as touching the managed file and only syncs'],
  ['idle', 'new_context', ['output', 'lost'], 'the gate allows a reset onto a valid edit and writes no output'],
  ['idle', 'PreCompact', ['output', 'lost'], 'compaction onto a valid edit writes no output'],
  ['idle', 'Stop', ['output', 'lost'], 'a Stop with no owed notice writes no output'],
  ['checking', 'Stop', ['state', 'record'], 'a Stop refuses an owed notice before any state write or core call'],
  ['pending', 'Stop', ['state', 'record'], 'a Stop refuses a pending notice before any state write or core call'],
  ['pending', 'new_context', ['sync'], 'the gate refuses a pending notice before its sync'],
  ['pending', 'PreCompact', ['state', 'sync', 'record'], 'compaction refuses a pending notice before any state write or core call'],
];
const pruned = (start: Start, kind: Kind, fault: Fault) => PRUNED.some(([s, k, faults]) => (s === '*' || s === start) && k === kind && faults.includes(fault));

const RECOVERY_TOOL = toolUse('Bash', { command: 'ls' }, 'RECOVERY_TOOL_OUTPUT', 'call_recovery');

/** The faulted event. Tool events keep one tool_use_id, so a retry is the same host event. */
const EVENTS: Record<Kind, (f: Fixture) => Record<string, unknown>> = {
  prompt: () => prompt('FAULT_PROMPT'),
  'own-file tool': f => toolUse('Write', { file_path: wcPath(f) }, 'write completed', 'call_fault_own'),
  'ordinary tool': () => toolUse('Bash', { command: 'make' }, 'FAULT_TOOL_OUTPUT', 'call_fault'),
  Stop: () => stop('FAULT_REPLY'),
  new_context: () => newContext,
  PreCompact: () => preCompact,
};

const edit = (f: Fixture) => writeFileSync(wcPath(f), `${readFileSync(wcPath(f), 'utf8').trimEnd()}\n${EDIT}\n`);

/** Each start leaves an accepted or pending model edit whose notice has not reached Codex. */
const SETUP: Record<Start, (f: Fixture) => Promise<void>> = {
  // The edit is in the file and no hook has seen it.
  idle: async f => { assert.equal((await runHook(f, SID, prompt('ACTIVE_TASK'))).status, 0); edit(f); },
  // A tool hook marked its check, committed the edit and died. Earlier hook versions leave this state.
  checking: async f => {
    await SETUP.idle(f);
    const sync = await startBounded([process.execPath, CLI, 'sync', '--session', SID, '--project', f.projectRoot, '--runner', 'codex', '--hard-limit', '960000'], { cwd: f.projectRoot, env: hookEnv(f), input: '', timeoutMs: 30_000 }).done;
    assert.equal(sync.status, 0, sync.stdout + sync.stderr);
    writeFileSync(join(stateDir(f), 'codex-read-notice.json'), JSON.stringify({ kind: 'checking', lastNotifiedRevision: 0 }));
  },
  // The tool hook that committed the edit lost its output, so the notice is pending.
  pending: async f => {
    await SETUP.idle(f);
    assert.notEqual((await runHook(f, SID, toolUse('Write', { file_path: wcPath(f) }, 'write completed', 'call_edit'), {}, 30_000, true)).status, 0);
  },
};

/** Kills the hook process, never its core CLI child, at one point, and leaves a file saying it fired. */
function faultPreload(f: Fixture, fault: Fault): string {
  const path = join(f.projectRoot, 'fault.mjs'), fired = JSON.stringify(join(f.projectRoot, 'fault-fired'));
  writeFileSync(path, `import fs from 'node:fs';import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
if(process.argv[1]?.endsWith('/codex-hook.ts')){
  const point=${JSON.stringify(fault)},write=fs.writeSync,spawn=cp.spawnSync;
  const die=()=>{fs.writeFileSync(${fired},point);process.kill(process.pid,'SIGKILL');};
  fs.writeSync=function(fd,data,...rest){
    if(point==='state'&&String(data).includes('"lastNotifiedRevision"'))die();
    const n=write.call(this,fd,data,...rest);
    if(point==='output'&&fd===1)die();
    return n;
  };
  cp.spawnSync=function(file,args,...rest){
    const r=spawn.call(this,file,args,...rest);
    if(Array.isArray(args)&&args[1]===point)die();
    return r;
  };
  syncBuiltinESMExports();
}`);
  return path;
}

/** Codex applies output only from a hook that exits 0 with empty stdout or exactly one JSON object. */
function applied(run: Run): Record<string, unknown> | undefined {
  if (run.status !== 0 || run.signal !== null) return undefined;
  if (run.stdout.trim() === '') return {};
  try { return JSON.parse(run.stdout) as Record<string, unknown>; } catch { return undefined; }
}

/** A Stop killed after it published its intent leaves the documented refused session (README). */
function stopDebt(f: Fixture): boolean {
  const dir = stateDir(f);
  return readdirSync(dir).some(name => name.startsWith('codex-record-pending-') && !('hostEvent' in JSON.parse(readFileSync(join(dir, name), 'utf8'))));
}

async function runCell(t: TestContext, start: Start, kind: Kind, fault: Fault): Promise<void> {
  const f = enabledFixture();
  const delivered: number[] = [];
  /** A notice in applied output must read back, at that moment, a revision that holds the edit. */
  const observe = async (run: Run, what: string) => {
    const context = (applied(run)?.hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext ?? '';
    const notice = /revision (\d+) was validated \(sha256 ([0-9a-f]{64})\)/.exec(context);
    if (!notice) return;
    const read = await startBounded([process.execPath, CLI, 'read', '--session', SID, '--sha', notice[2]!], { cwd: f.projectRoot, env: hookEnv(f), input: '', timeoutMs: 30_000 }).done;
    assert.equal(read.status, 0, `${what}: the notice for revision ${notice[1]} reads back: ${read.stdout}${read.stderr}`);
    assert.match(read.stdout, new RegExp(EDIT), `${what}: revision ${notice[1]} holds the edit`);
    delivered.push(Number(notice[1]));
  };
  await SETUP[start](f);
  const fields = EVENTS[kind](f);
  const extra: Record<string, string> = fault === 'none' || fault === 'lost' ? {} : { NODE_OPTIONS: `--import=${faultPreload(f, fault)}` };
  await observe(await runHook(f, SID, fields, extra, 40_000, fault === 'lost'), 'faulted event');
  if (extra.NODE_OPTIONS) t.diagnostic(existsSync(join(f.projectRoot, 'fault-fired')) ? 'fault fired' : 'fault point not reached');
  if (stopDebt(f)) {
    const next = await runHook(f, SID, prompt('RECOVERY_PROMPT'));
    assert.ok(stoppedContinuation(next), `a killed Stop leaves the session refused: ${next.stdout}`);
    return;
  }
  // A faulted prompt or tool event that left its intent is sent again first, since only the same
  // event clears it. Codex sends no event twice otherwise.
  const intents = readdirSync(stateDir(f)).filter(name => name === 'codex-prompt-pending.json' || name.startsWith('codex-record-pending-'));
  const retry = intents.length && (kind === 'prompt' || kind.endsWith('tool')) ? [fields] : [];
  const runs: Run[] = [];
  for (const [i, next] of [...retry, RECOVERY_TOOL, prompt('RECOVERY_PROMPT'), stop('RECOVERY_REPLY')].entries()) {
    const run = await runHook(f, SID, next);
    assert.equal(run.status, 0, `recovery event ${i}: ${run.stderr}`);
    await observe(run, `recovery event ${i}`);
    runs.push(run);
  }
  assert.ok(delivered.length > 0, 'the accepted edit reached applied output as a readable notice');
  const texts = loggedEvents(f, SID).map(e => e.event.text);
  const count = (output: string) => texts.filter(t => t.includes(output)).length;
  assert.equal(count('RECOVERY_TOOL_OUTPUT'), 1, 'the recovery tool output is in the Event Log once');
  // In the idle start the faulted tool's own sync commits the edit, which marks it as the editing tool,
  // so its output is left out unless a retry finds the edit already committed.
  if (kind === 'ordinary tool' && start === 'idle') assert.ok(count('FAULT_TOOL_OUTPUT') <= 1, 'the faulted tool output is never recorded twice');
  else if (kind === 'ordinary tool') assert.equal(count('FAULT_TOOL_OUTPUT'), 1, 'the faulted tool output is in the Event Log once');
  assert.equal(runs.at(-1)!.stdout, '', 'the session ends usable: the last Stop is not refused');
}

describe('[CDX-009] read-notice fault sweep', { concurrency: 4 }, () => {
  for (const start of STARTS) for (const kind of KINDS) for (const fault of FAULTS) {
    if (pruned(start, kind, fault)) continue;
    test(`${start} | ${kind} | ${fault}`, t => runCell(t, start, kind, fault));
  }
});

test('[CDX-009] the fault preload fires where the sweep says it does', async () => {
  const f = enabledFixture();
  await SETUP.pending(f);
  await runHook(f, SID, EVENTS['ordinary tool'](f), { NODE_OPTIONS: `--import=${faultPreload(f, 'sync')}` });
  assert.equal(existsSync(join(f.projectRoot, 'fault-fired')), true);
});
