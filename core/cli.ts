#!/usr/bin/env node
import {writeSync} from 'node:fs';
// context-engine CLI: a thin shell over the core library. Prints one JSON object on stdout.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  cite,
  inspectSession,
  openSession,
  participation,
  readWorkingContext,
  READ_MAX_BYTES,
  recall,
  RECALL_MAX_BYTES,
  show,
  SHOW_MAX_BYTES,
  sessionProjectFrom,
  type OpenOptions,
  type RunnerEvent,
  type SyncResult,
  withSessionSerialized,
} from './index.ts';

let resultOutputStarted=false, resultOutputCompleted=false;

const HELP = `context-engine: model-controlled Working Context for coding agents (shared core).

Usage: context-engine <command> --session <id> [options]
       context-engine install|uninstall|enable|disable|status [options]

Setup (for people; see \`context-engine install --help\`):
  install    Install the Claude Code plugins and/or the Codex plugin.
  uninstall  Remove them and restore the runner configs install changed.
  enable     Turn Context Engine on for this project (the pilot is opt-in).
  disable    Turn it off for this project.
  status     Without --session: delivery mode per runner, whether this project
             is enabled, the kill switch and experiments.

Session commands (for adapters; one JSON object on stdout):
  open     Open or resume a session: take the lock, recover after a crash, sync.
  sync     Commit a model edit to the Working Context as a new revision, or
           restore the last revision if the file is missing, empty, not UTF-8
           or over the hard limit. Prints a receipt when something happened.
  record   Read runner events from stdin (a JSON array of {"role","text",...},
           or one object), write them to the Event Log, render them as turn
           blocks and commit. Always syncs first.
  native-compaction
           Read the runner's own compaction result from stdin (events, as
           for record) and make it the whole next revision (kind
           native-compaction): the Compaction-only fallback, for a Working
           Context over its budget. Always syncs first.
  close    Release the session lock.
  status   Read-only: revision, size, paths and lock holder. Takes no lock.
  recall   recall --session <id> <query...>
           Search this session's Event Log (runner events and rejected edits)
           for items containing every word of the query, case-insensitive,
           newest first. Returns short snippets with event ids. Output is at
           most ${RECALL_MAX_BYTES} bytes; "truncated":true means matches were left
           out. Takes no lock; logs the query and hit count to the Event Log.
           Put -- before a query that starts with '-'.
           recall and show read only a session of the project you are in:
           the nearest directory at or above the current one that holds
           .context-engine/<id>/. They take no --project, and a session of
           another project (or an id this project never had) is refused.
           This prevents accidental cross-project reads; it is not a security
           boundary against another process of the same user.
  show     show --session <id> <event-id>
           One event (e.g. e12, r1) from this session's Event Log, at most
           ${SHOW_MAX_BYTES} bytes; "truncated":true means the text was cut. Takes no lock.
  read     read --session <id> [--part <n> --sha <digest>]
           Print part n (default 1) of this session's Working Context file
           as plain text, behind a header line naming the part, the total
           and the next command. Each output is at most ${READ_MAX_BYTES} bytes, under
           Codex's tool-output cap, and the parts put together are the file.
           For later parts, copy the printed next command including --sha.
           A changed file refuses continuation: restart with part 1.
           Like recall: no --project, no lock; logged for eval accounting.
  cite     Experiment (stale-refs): print a marker citing <path>[#L<from>[-<to>]]
           or commit:<rev>, e.g. ⟦src:core/cli.ts#L10-20@1a2b3c4d⟧. Needs no
           session. Prints the marker line, not JSON (errors are JSON).

Options:
  --session <id>      Runner session id (letters, digits, '.', '_', '-').
  --project <dir>     Project root (default: current directory). Not for
                      recall/show.
  --runner <name>     Runner label, e.g. claude-code or codex.
  --hard-limit <n>    Runner hard limit in characters (JS string length).
  --max-context-bytes <n>
                      record only: refuse before logging if the rendered next
                      revision exceeds this UTF-8 byte cap (at most 64 MiB).
  --operation-id <uuid>
                      record only: reuse this ID for retries of one event batch.
                      New batches need new IDs, even when their text matches.
  --budget <tokens>   open|sync|record|native-compaction: the Working
                      Context's budget. Results then carry "budget": a size
                      readout and any reminder it fired (25/50/75% once
                      each; urgent near the limit; over budget).
  --owner-pid <pid>   Process that owns the session lock (default: the parent
                      process of this CLI). Pass your long-lived adapter pid
                      if you call the CLI through a shell.
  --if-enabled        open|sync|record: when Context Engine is not active for
                      the project (not enabled, or the kill switch is on), do
                      nothing and print {"ok":true,"active":false,"reason"}.
                      Adapters always pass it.
  -h, --help          Show this help.

--runner and --hard-limit are required by open. Later commands from the same
owner reuse the values stored in the lock unless given again.

Output (stdout, one JSON object):
  open|sync|record  {"ok":true,"revision":n,"chars":n,"turns":[{"role","text"}],
                     "workingContext":"<path>","receipt"?:{"kind","revision",
                     "chars","text",...},"budget"?:{"budgetTokens","approxTokens",
                     "percent","overBudget","tier","urgent","text"}}
                    (native-compaction prints the same; open adds "frameKey",
                     the session's random id an adapter marks its frames with.)
  close             {"ok":true,"closed":true}
  status            {"ok":true,"revision":n,"chars":n,"workingContext":"<path>",
                     "stateDir":"<path>","lock":{pid,hostname,...,"live"}|null,
                     "revisionKind":"runner-append"|"model-edit"|
                     "native-compaction"|"init"|null}
  read              Plain text: the header line, then the part.
  recall            {"ok":true,"query":"...","hits":[{"id","role","snippet"}],
                     "total":n,"truncated":bool}
  show              {"ok":true,"id","role","text","chars":n,"truncated":bool}
                    recall/show add "accounting":"skipped" and a "note" when the
                    call could not be logged (Event Log not writable, e.g. from a
                    sandboxed shell); the result itself is complete.

Receipts carry "approxTokens": the Working Context size as chars/4, an
approximation (not a tokenizer count).
  errors            {"ok":false,"error":"<message>"}           exit 1
  lock refused      {"ok":false,"error":"refused","holder":{...}} exit 2

Environment:
  CONTEXT_ENGINE=off        Kill switch: both adapters stand aside (with
                            --if-enabled), nothing is uninstalled.
  CONTEXT_ENGINE_STATE_DIR  State root (default: $XDG_STATE_HOME/context-engine,
                            i.e. ~/.local/state/context-engine). Mode 0700.
  CONTEXT_ENGINE_EXPERIMENTS  Comma-separated experiments to turn on. With
                            stale-refs, sync checks the cite markers in the
                            Working Context and receipts list stale ones
                            (at most 5, plus a count) in "stale".

The Working Context is <project>/.context-engine/<session>/context.md.
`;

class Usage extends Error {}

/** Test-only: the project recall/show read, instead of the one found from the current directory. */
const TEST_PROJECT_ENV = 'CONTEXT_ENGINE_TEST_PROJECT';

function main(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      session: { type: 'string' },
      project: { type: 'string' },
      runner: { type: 'string' },
      'hard-limit': { type: 'string' },
      'max-context-bytes': { type: 'string' },
      'operation-id': { type: 'string' },
      'owner-pid': { type: 'string' },
      budget: { type: 'string' },
      part: { type: 'string' },
      sha: { type: 'string' },
      'if-enabled': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help || positionals.length === 0) {
    process.stdout.write(HELP);
    return values.help ? 0 : 1;
  }
  const [command, ...rest] = positionals;
  if(values['max-context-bytes']!==undefined&&command!=='record')throw new Usage('--max-context-bytes applies only to record');
  if(values['operation-id']!==undefined&&command!=='record')throw new Usage('--operation-id applies only to record');
  const projectRoot = values.project ?? process.cwd();
  if (command === 'cite') {
    if (rest.length !== 1) throw new Usage('cite takes one argument: <path>[#L<from>[-<to>]] or commit:<rev>');
    const ref = rest[0]!;
    // Paths are relative to the current directory, like any shell argument.
    process.stdout.write(`${cite(projectRoot, ref.startsWith('commit:') ? ref : resolve(ref))}\n`);
    return 0;
  }
  if (!['open', 'sync', 'record', 'native-compaction', 'close', 'status', 'recall', 'show', 'read'].includes(command!)) throw new Usage(`unknown command: ${command} (see --help)`);
  if (!values.session) throw new Usage('--session is required');

  const sessionId = values.session;
  // recall and show only read the Event Log (and count themselves in it): no lock, no recovery.
  // They read the caller's own project only: no --project (see sessionProjectFrom).
  if (command === 'recall' || command === 'show' || command === 'read') {
    if (values.project !== undefined) throw new Usage(`${command} takes no --project: it reads sessions of the project you are in (run it from there)`);
    if (command === 'show' && rest.length !== 1) throw new Usage('show takes exactly one event id');
    if (command === 'read' && rest.length) throw new Usage(`unexpected argument: ${rest[0]}`);
    const own = process.env[TEST_PROJECT_ENV] || sessionProjectFrom(process.cwd(), sessionId);
    if (command === 'read') {
      // Plain text for the agent, not JSON: escaping would make every part larger and harder to read.
      process.stdout.write(readWorkingContext({ projectRoot: own, sessionId, part: values.part ? positiveInt(values.part, '--part') : 1, sha: values.sha }).text);
      return 0;
    }
    if (command === 'recall') return print({ ok: true, ...recall({ projectRoot: own, sessionId, query: rest.join(' ') }) });
    return print({ ok: true, ...show({ projectRoot: own, sessionId, id: rest[0]! }) });
  }
  if (rest.length) throw new Usage(`unexpected argument: ${rest[0]}`);
  if (values['if-enabled'] && command !== 'status' && command !== 'close') {
    const p = participation({ projectRoot });
    if (!p.active) return print({ ok: true, active: false, reason: p.reason });
  }
  if (command === 'status') return print({ ok: true, ...inspectSession({ projectRoot, sessionId }) });

  const ownerPid = values['owner-pid'] ? positiveInt(values['owner-pid'], '--owner-pid') : process.ppid;
  const events = command === 'record' || command === 'native-compaction' ? readEvents() : [];
  const budgetTokens = values.budget ? positiveInt(values.budget, '--budget') : undefined;
  // One operation at a time per session, even for calls that present the same owner.
  return withSessionSerialized({ projectRoot, sessionId }, () => {
    const status = inspectSession({ projectRoot, sessionId });
    const ownLock = status.lock && status.lock.pid === ownerPid ? status.lock : null;
    const runner = values.runner ?? ownLock?.runner;
    const hardLimit = values['hard-limit'] ? positiveInt(values['hard-limit'], '--hard-limit') : ownLock?.hardLimit;
    if (runner === undefined || hardLimit === undefined) {
      if (status.lock?.live && !ownLock) return refuse(status.lock);
      throw new Usage(`session ${sessionId} is not open for this owner: run \`context-engine open\` first, or pass --runner and --hard-limit`);
    }
    const opts: OpenOptions = { projectRoot, sessionId, runner, hardLimit, ownerPid, ...(budgetTokens ? { budgetTokens } : {}) };
    const opened = openSession(opts);
    if (opened.status === 'refused') return refuse(opened.holder);
    const s = opened.session;
    if (command === 'close') {
      s.close();
      return print({ ok: true, closed: true });
    }
    const result: SyncResult = command === 'record' ? s.record(events, {maxBytes: values['max-context-bytes'] !== undefined ? positiveInt(values['max-context-bytes'],'--max-context-bytes') : undefined, operationId: values['operation-id']}) : command === 'native-compaction' ? s.nativeCompaction(events) : s.sync();
    const bytes=Buffer.from(`${JSON.stringify({ ok: true, ...result, workingContext: s.workingContextPath, ...(command === 'open' ? { frameKey: s.frameKey } : {}) })}\n`);
    resultOutputStarted=true;
    const outputDeadline=Date.now()+5000;
    for(let offset=0;offset<bytes.length;){
      try {const n=writeSync(1,bytes,offset,bytes.length-offset);if(n<=0)throw new Error('result output made no progress');offset+=n;}
      catch(error){if(!['EAGAIN','EWOULDBLOCK'].includes((error as NodeJS.ErrnoException).code??'')||Date.now()>=outputDeadline)throw error;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1);}
    }
    resultOutputCompleted=true;
    // Written to the CLI output transport; this does not prove a model received it.
    try { s.confirmReceiptReturn(); }
    catch { process.stderr.write('Context Engine: recovery receipt acknowledgement unverified; a later call may repeat the notice.\n'); }
    return 0;
  });
}

function readEvents(): RunnerEvent[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    throw new Usage('record expects JSON on stdin: an array of {"role","text"} events or one event');
  }
  const events = Array.isArray(parsed) ? parsed : [parsed];
  if (events.some((e) => !e || typeof e !== 'object' || typeof e.role !== 'string' || typeof e.text !== 'string')) {
    throw new Usage('each event needs string "role" and "text" fields');
  }
  return events as RunnerEvent[];
}

function positiveInt(v: string, flag: string): number {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Usage(`${flag} must be a positive integer`);
  return n;
}

function refuse(holder: unknown): number {
  print({ ok: false, error: 'refused', holder });
  return 2;
}

function print(obj: unknown): number {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
  return 0;
}

/** Setup commands are for people: text output, their own options (setup/cli.ts). */
function isSetupCommand(argv: string[]): boolean {
  const [first] = argv;
  return ['install', 'uninstall', 'enable', 'disable'].includes(first!) || (first === 'status' && !argv.some((a) => a === '--session' || a.startsWith('--session=')));
}

const argv = process.argv.slice(2);
if (isSetupCommand(argv)) {
  const { runSetup } = await import('../setup/cli.ts');
  process.exitCode = await runSetup(argv);
} else {
  try {
    process.exitCode = main(argv);
  } catch (e) {
    if(resultOutputStarted){
      // Never corrupt an already written result with a second JSON object.
      process.stderr.write(resultOutputCompleted ? 'Context Engine: result output completed; post-output cleanup failed.\n' : 'Context Engine: result output incomplete; retry after repairing the output transport.\n');
      process.exitCode=resultOutputCompleted?0:1;
    }else{
      print({ ok: false, error: e instanceof Error ? e.message : String(e) });
      process.exitCode = 1;
    }
  }
}
