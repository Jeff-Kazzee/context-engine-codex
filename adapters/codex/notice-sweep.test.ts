// Fault sweep over the read-notice state machine. Each cell starts a session in one notice state with
// a model edit at stake, runs one hook event with one fault, then runs ordinary recovery events.
// The oracle, checked before any event is sent twice: the edit reaches applied hook output as a read
// notice whose digest reads back the edit at that moment, and the recovery tool output is in the Event
// Log once. After the documented recovery, which sends a faulted prompt or tool event again: the
// faulted tool output is in the Event Log once and the last Stop is not refused.
// A cell is a (start, event, fault) triple. The sweep runs every triple in scope that PRUNED does not
// exclude, and every fault must fire, so a new cell is one line: a value on an axis, or one less PRUNED
// rule. SWEEP_PRUNED=1 runs the pruned triples instead and checks that none of their faults fires.
import './testing/private-tmp.ts';
import { describe, test } from 'node:test';
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
const noticePath = (f: Fixture) => join(stateDir(f), 'codex-read-notice.json');

type Start = 'idle' | 'checking' | 'pending' | 'clean';
type Kind = 'prompt' | 'own-file tool' | 'ordinary tool' | 'parallel, edit first' | 'parallel, edit last' | 'Stop' | 'new_context' | 'PreCompact';
type Fault = 'none' | 'state' | 'sync' | 'record' | 'output' | 'delivered' | 'lost' | 'sync-fail' | 'sync-late' | 'race' | 'race-kill' | 'race-late';

const STARTS: Start[] = ['idle', 'checking', 'pending', 'clean'];
const KINDS: Kind[] = ['prompt', 'own-file tool', 'ordinary tool', 'parallel, edit first', 'parallel, edit last', 'Stop', 'new_context', 'PreCompact'];
// state: killed before the first notice state write. sync, record: killed as that core call returns.
// output: killed after the first hook output write, so Codex applies none of it. delivered: killed
// after the hook marked its notice delivered. lost: stdout closed, so every output write fails.
// sync-fail: every sync call reports a timeout without running, and the hook runs on. sync-late: every
// sync call runs, commits what it finds, and then reports a timeout. race: the agent edits the file
// again while the first record call runs, so that call commits the edit. race-kill: the same, then a
// kill as the record call returns. race-late: the same, then the record call reports a timeout.
const FAULTS: Fault[] = ['none', 'state', 'sync', 'record', 'output', 'delivered', 'lost', 'sync-fail', 'sync-late', 'race', 'race-kill', 'race-late'];
const RACES: Fault[] = ['race', 'race-kill', 'race-late'];

/** Out of scope by design: the clean start has no edit at stake until a race writes one. */
const inScope = (start: Start, fault: Fault) => start !== 'clean' || RACES.includes(fault);
/** Triples this hook version does not reach, each with the reason. Every other fault must fire. */
const PRUNED: Array<[Start | '*', Kind | '*', Fault[], string]> = [
  ['*', 'own-file tool', ['record', ...RACES], 'a tool that touched the managed file only syncs'],
  ['*', 'new_context', ['state', 'record', 'delivered', ...RACES], 'the reset gate writes no notice state and never records'],
  ['*', 'PreCompact', ['delivered'], 'compaction never delivers a notice'],
  ['*', 'Stop', ['sync', 'delivered', 'sync-fail', 'sync-late'], 'a Stop makes no sync call and never delivers a notice'],
  ['idle', 'new_context', ['output', 'lost'], 'the gate allows a reset onto a valid edit and writes no output'],
  ['checking', 'new_context', ['output', 'lost'], 'the gate allows a reset over an edit owed at HEAD and writes no output'],
  ['idle', 'PreCompact', ['output', 'lost'], 'compaction onto a valid edit writes no output'],
  ['checking', 'PreCompact', ['output', 'lost'], 'compaction carries an edit owed at HEAD and writes no output'],
  ['*', 'Stop', ['output', 'lost'], 'a Stop carries an owed notice and writes no output'],
  ['pending', 'new_context', ['sync', 'sync-fail', 'sync-late'], 'the gate refuses a pending notice before its sync'],
  ['pending', 'PreCompact', ['state', 'sync', 'record', 'sync-fail', 'sync-late', ...RACES], 'compaction refuses a pending notice before any state write or core call'],
];
const pruned = (start: Start, kind: Kind, fault: Fault) => PRUNED.some(([s, k, faults]) => (s === '*' || s === start) && (k === '*' || k === kind) && faults.includes(fault));

const ordinaryTool = toolUse('Bash', { command: 'make' }, 'FAULT_TOOL_OUTPUT', 'call_fault');
/** A shell command that wrote the Working Context and names it. */
const shellEdit = toolUse('Bash', { command: `sed -i 's/^/ /' .context-engine/${SID}/context.md` }, 'SHELL_EDIT_OUTPUT', 'call_shell_edit');

/**
 * The faulted event, as hooks run one after the other. The fault applies to the last one. Tool events
 * keep one tool_use_id, so a resend is the same host event.
 */
const EVENTS: Record<Kind, (f: Fixture) => Array<Record<string, unknown>>> = {
  prompt: () => [prompt('FAULT_PROMPT')],
  'own-file tool': f => [toolUse('Write', { file_path: wcPath(f) }, 'OWN_FILE_OUTPUT', 'call_fault_own')],
  'ordinary tool': () => [ordinaryTool],
  // Codex 0.161.0 runs tools that support parallel calls, such as shell commands, at the same time.
  // Each tool's PostToolUse hook runs when that tool finishes, and the model reads every result after
  // the last one (codex-rs/core/src/tools/registry.rs and parallel.rs at rust-v0.161.0). apply_patch
  // and other tools without that support run alone.
  'parallel, edit first': () => [shellEdit, ordinaryTool],
  'parallel, edit last': () => [ordinaryTool, shellEdit],
  Stop: () => [stop('FAULT_REPLY')],
  new_context: () => [newContext],
  PreCompact: () => [preCompact],
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
    writeFileSync(noticePath(f), JSON.stringify({ kind: 'checking', lastNotifiedRevision: 0 }));
  },
  // The tool hook that committed the edit lost its output, so the notice is pending.
  pending: async f => {
    await SETUP.idle(f);
    assert.notEqual((await runHook(f, SID, toolUse('Write', { file_path: wcPath(f) }, 'write completed', 'call_edit'), {}, 30_000, true)).status, 0);
  },
  // Nothing is owed. The only edit at stake is the one a race writes during a record call.
  clean: async f => { assert.equal((await runHook(f, SID, prompt('ACTIVE_TASK'))).status, 0); },
};

/** Kills the hook process, never its core CLI child, at one point, and leaves a file saying it fired. */
function faultPreload(f: Fixture, fault: Fault): string {
  const path = join(f.projectRoot, 'fault.mjs'), fired = JSON.stringify(join(f.projectRoot, 'fault-fired')), wc = JSON.stringify(wcPath(f));
  writeFileSync(path, `import fs from 'node:fs';import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
if(process.argv[1]?.endsWith('/codex-hook.ts')){
  const point=${JSON.stringify(fault)},write=fs.writeSync,rename=fs.renameSync,spawn=cp.spawnSync;
  const die=()=>{fs.writeFileSync(${fired},point);process.kill(process.pid,'SIGKILL');};
  const fail=()=>{fs.writeFileSync(${fired},point);return {status:null,signal:'SIGTERM',stdout:'',stderr:'',output:[],pid:0,error:Object.assign(new Error('synthetic core timeout'),{code:'ETIMEDOUT'})};};
  // A delivery write marks this hook's own notice delivered, after this process started.
  let delivery=false;const started=Math.floor(performance.timeOrigin);
  fs.writeSync=function(fd,data,...rest){
    if(point==='state'&&String(data).includes('"lastNotifiedRevision"'))die();
    if(fd!==1&&fd!==2){try{const v=JSON.parse(String(data));delivery=v.kind==='idle'&&typeof v.deliveredAt==='number'&&v.deliveredAt>=started;}catch{delivery=false;}}
    const n=write.call(this,fd,data,...rest);
    if(point==='output'&&fd===1)die();
    return n;
  };
  fs.renameSync=function(from,to,...rest){
    const r=rename.call(this,from,to,...rest);
    if(point==='delivered'&&delivery&&String(to).endsWith('codex-read-notice.json'))die();
    return r;
  };
  let raced=false;
  cp.spawnSync=function(file,args,...rest){
    const call=Array.isArray(args)?args[1]:undefined;
    if(point==='sync-fail'&&call==='sync')return fail();
    const race=point.startsWith('race')&&call==='record'&&!raced;
    if(race){raced=true;fs.writeFileSync(${fired},point);fs.writeFileSync(${wc},fs.readFileSync(${wc},'utf8').trimEnd()+'\\nRACE_SENTINEL\\n');}
    const r=spawn.call(this,file,args,...rest);
    if(point==='sync-late'&&call==='sync')return fail();
    if(race&&point==='race-kill')die();
    if(race&&point==='race-late')return fail();
    if(call===point)die();
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

const NOTICE = /revision (\d+) was validated \(sha256 ([0-9a-f]{64})\)/;

/** A Stop killed after it published its intent leaves the documented refused session (README). */
function stopDebt(f: Fixture): boolean {
  const dir = stateDir(f);
  return readdirSync(dir).some(name => name.startsWith('codex-record-pending-') && !('hostEvent' in JSON.parse(readFileSync(join(dir, name), 'utf8'))));
}

/** The notice is still owed in durable state: pending, or a model edit logged above the last notified revision. */
function stillOwed(f: Fixture): boolean {
  const state = existsSync(noticePath(f)) ? JSON.parse(readFileSync(noticePath(f), 'utf8')) as { kind: string; lastNotifiedRevision: number } : { kind: 'idle', lastNotifiedRevision: 0 };
  if (state.kind === 'pending') return true;
  const rows = readFileSync(layout(f.projectRoot, SID, f.stateDir).events, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  return rows.some(row => row.type === 'revision' && row.kind === 'model-edit' && row.rev > state.lastNotifiedRevision);
}

async function runCell(start: Start, kind: Kind, fault: Fault, checkPrune = false): Promise<void> {
  const f = enabledFixture();
  const delivered: number[] = [], readBacks: string[] = [];
  /**
   * The newest notice in applied output must read back, at that moment, a revision that holds the
   * edit. Codex hands the model every output of parallel hooks at once, so within such a group a newer
   * notice supersedes an older one.
   */
  const observe = async (group: Run[], what: string, staleAllowed = false) => {
    const notices = group.map(run => NOTICE.exec(String((applied(run)?.hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext ?? '')));
    const notice = notices.filter(n => n !== null).sort((a, b) => Number(b[1]) - Number(a[1]))[0];
    if (!notice) return;
    const read = await startBounded([process.execPath, CLI, 'read', '--session', SID, '--sha', notice[2]!], { cwd: f.projectRoot, env: hookEnv(f), input: '', timeoutMs: 30_000 }).done;
    if (staleAllowed && read.status !== 0) return;
    assert.equal(read.status, 0, `${what}: the notice for revision ${notice[1]} reads back: ${read.stdout}${read.stderr}`);
    assert.match(read.stdout, new RegExp(start === 'clean' ? 'RACE_SENTINEL' : EDIT), `${what}: revision ${notice[1]} holds the edit`);
    delivered.push(Number(notice[1]));
    readBacks.push(read.stdout);
  };
  await SETUP[start](f);
  const group = EVENTS[kind](f);
  const extra: Record<string, string> = fault === 'none' || fault === 'lost' ? {} : { NODE_OPTIONS: `--import=${faultPreload(f, fault)}` };
  const runs: Run[] = [];
  for (const [i, fields] of group.entries()) {
    runs.push(i === group.length - 1 ? await runHook(f, SID, fields, extra, 40_000, fault === 'lost') : await runHook(f, SID, fields));
  }
  const faulted = runs.at(-1)!;
  if (checkPrune) {
    if (extra.NODE_OPTIONS) assert.equal(existsSync(join(f.projectRoot, 'fault-fired')), false, `the pruned ${fault} fault does not fire`);
    if (fault === 'lost') assert.equal(faulted.status, 0, 'the pruned hook writes no output');
    return;
  }
  if (extra.NODE_OPTIONS) assert.equal(existsSync(join(f.projectRoot, 'fault-fired')), true, `the ${fault} fault fired`);
  if (fault === 'lost') assert.notEqual(faulted.status, 0, 'the hook wrote output to the closed stdout');
  // A faulted parallel hook can record and then fail to write the notice that supersedes the other
  // hook's, which leaves that one stale. Recovery must then deliver a fresh one.
  await observe(runs, 'faulted event', runs.length > 1 && fault !== 'none');
  if (stopDebt(f)) {
    const next = await runHook(f, SID, prompt('RECOVERY_PROMPT'));
    assert.ok(stoppedContinuation(next), `a killed Stop leaves the session refused: ${next.stdout}`);
    assert.ok(stillOwed(f), 'the notice stays owed in durable state');
    return;
  }
  // The one loss the README documents: Codex applies none of a killed hook's output, and this hook
  // had already marked the notice it wrote as delivered.
  const documentedLoss = fault === 'delivered' && NOTICE.test(faulted.stdout)
    && existsSync(noticePath(f)) && JSON.parse(readFileSync(noticePath(f), 'utf8')).kind === 'idle';
  for (const [i, next] of [toolUse('Bash', { command: 'ls' }, 'RECOVERY_TOOL_OUTPUT', 'call_recovery'), prompt('RECOVERY_PROMPT')].entries()) {
    await observe([await runHook(f, SID, next)], `recovery event ${i}`);
  }
  if (!documentedLoss) assert.ok(delivered.length > 0, 'the accepted edit reached applied output as a readable notice');
  if (RACES.includes(fault)) assert.ok(readBacks.some(text => text.includes('RACE_SENTINEL')), 'the edit made during the record call reached a readable notice');
  const count = (output: string) => loggedEvents(f, SID).filter(e => e.event.text.includes(output)).length;
  assert.equal(count('RECOVERY_TOOL_OUTPUT'), 1, 'the recovery tool output is in the Event Log once');
  // Documented recovery: only the same event clears its own intent (README). A user retries a refused
  // prompt. Codex does not send a failed tool hook again, so a killed tool hook otherwise leaves the
  // session refused until Context Engine is disabled.
  const intents = readdirSync(stateDir(f)).filter(name => name === 'codex-prompt-pending.json' || name.startsWith('codex-record-pending-'));
  const resend = intents.length && (kind === 'prompt' || kind.endsWith('tool') || kind.startsWith('parallel')) ? group : [];
  let last: Run | undefined;
  for (const next of [...resend, prompt('LATER_PROMPT'), stop('RECOVERY_REPLY')]) {
    last = await runHook(f, SID, next);
    assert.equal(last.status, 0, last.stderr);
  }
  if (group.includes(ordinaryTool)) assert.equal(count('FAULT_TOOL_OUTPUT'), 1, 'the ordinary tool output is in the Event Log once');
  // A Stop that ran to the end records its reply, whatever notice is owed.
  if (kind === 'Stop' && (fault === 'none' || fault === 'race')) assert.equal(count('FAULT_REPLY'), 1, 'the Stop reply is in the Event Log once');
  assert.equal(count('OWN_FILE_OUTPUT'), 0, 'a tool that wrote the managed file never echoes into it');
  // A shell edit whose hook runs second finds the edit already committed, so it reads as ordinary.
  assert.ok(count('SHELL_EDIT_OUTPUT') <= 1, 'a shell edit is never recorded twice');
  assert.equal(last!.stdout, '', 'the session ends usable: the last Stop is not refused');
}

const CHECK_PRUNED = process.env.SWEEP_PRUNED === '1';
describe(CHECK_PRUNED ? '[CDX-009] read-notice fault sweep, pruned triples' : '[CDX-009] read-notice fault sweep', { concurrency: 4 }, () => {
  for (const start of STARTS) for (const kind of KINDS) for (const fault of FAULTS) {
    if (!inScope(start, fault) || pruned(start, kind, fault) !== CHECK_PRUNED) continue;
    test(`${start} | ${kind} | ${fault}`, () => runCell(start, kind, fault, CHECK_PRUNED));
  }
});
