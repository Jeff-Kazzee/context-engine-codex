// The shared core: one deep module behind openSession / sync / record / close.
//
// Write protocol (decided in issue #7, prototyped on prototype/core-state):
// - HEAD is the commit point. A snapshot no HEAD points at is an orphan and is removed on recovery.
// - Every write is temp + rename. Temp files left by a crash are removed on recovery.
// - Runner events are appended to the Event Log *before* they are applied; HEAD.through records the
//   last event a revision includes, and recovery replays anything later (write-ahead).
// - The Working Context is a materialized view of HEAD. A runner append commits first and then
//   rewrites the file; HEAD.materialized says whether that rewrite finished.
// - record() always syncs first, so a runner append never overwrites an uncommitted model edit.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { crashPoint } from './faults.ts';
import { acquireLock, holderFor, isAlive, readLock, releaseLock, serialized, type LockHolder } from './lock.ts';
import {
  appendCommitted,
  appendLog,
  atomicWrite,
  ensureDirs,
  layout,
  readBytes,
  readLog,
  readLogRows,
  readWorkingContextFile,
  assertWorkingContextDir,
  removeTemps,
  removeDirectoryEntries,
  replaceWorkingContext,
  resolveStateRoot,
  sessionFrameKey,
  sha,
  truncateTornTail,
  type Layout,
  type WorkingContextRead,
  type LogRange,
} from './store.ts';
import { countHeaders, parseTurns, renderTurns, type Turn } from './turns.ts';
import { checkRefs, experimentOn, staleText, type StaleReport } from './refs.ts';
import { budgetMemory, checkBudget, remember, type BudgetMemory, type BudgetReport } from './budget.ts';
import { COMPACTION_ONLY_FALLBACK } from './delivery.ts';
import { approxTokens } from './size.ts';
import { retainRunnerEvent } from './event-safety.ts';

export interface OpenOptions {
  /** The project (workspace) root. The Working Context lives at `<projectRoot>/.context-engine/<sessionId>/context.md`. */
  projectRoot: string;
  /** Runner session id: letters, digits, '.', '_' or '-'. */
  sessionId: string;
  /** Runner label, e.g. 'claude-code' or 'codex'. Recorded in the lock and Event Log. */
  runner: string;
  /**
   * The runner's hard limit, in characters (JS string length, UTF-16 code units). A Working
   * Context longer than this could never be sent, so a model edit over it is restored from HEAD.
   * Adapters that think in tokens convert (roughly 4 characters per token). No other size rule.
   */
  hardLimit: number;
  /** Process that owns the session lock. Defaults to the current process. */
  ownerPid?: number;
  /** State root override. Defaults to $CONTEXT_ENGINE_STATE_DIR, then $XDG_STATE_HOME/context-engine. */
  stateDir?: string;
  /** Experiments to turn on, e.g. ['stale-refs']. Defaults to $CONTEXT_ENGINE_EXPERIMENTS (comma-separated). */
  experiments?: string[];
  /**
   * The Working Context's budget in tokens, as the adapter reckons it (the room its runner leaves the
   * Working Context). With it, every sync/record result carries a BudgetReport: a size readout and
   * the reminders it fired (core/budget.ts). Without it, the core imposes and reports no budget.
   */
  budgetTokens?: number;
}

/** A runner event: rendered into the Working Context as one turn block, retained in the Event Log subject to the credential-retention policy. */
export interface RunnerEvent {
  /** 'user', 'assistant', or any runner label ('tool', ...). Non-assistant roles parse back as user. */
  role: string;
  /** Text rendered into the Working Context. */
  text: string;
  /** Adapter metadata retained subject to the same credential policy (never rendered). */
  [extra: string]: unknown;
}

export type RestoreReason = 'missing' | 'empty' | 'not-utf8' | 'over-hard-limit' | 'not-a-file' | 'unmaterialized-append';

export { approxTokens };

const sizeReadout = (chars: number): string => `Working Context size: ~${approxTokens(chars)} tokens (approx., chars/4).`;

/**
 * Adapter-authored notice for the model. Never contains model-authored text, except stale-reference
 * markers (experiment), which only match a narrow pattern. `stale` is present only with the
 * stale-refs experiment on; kind 'stale' is a sync that changed nothing but found stale references.
 * `approxTokens` (every kind) is the Working Context size after this receipt, approximated as
 * chars / 4 (see approxTokens).
 */
export type Receipt = (
  | { kind: 'committed'; revision: number; previousChars: number; chars: number; text: string }
  | { kind: 'restored'; revision: number; reason: RestoreReason; chars: number; text: string }
  | { kind: 'stale'; revision: number; chars: number; text: string }
) & { approxTokens: number; stale?: StaleReport };

export interface SyncResult {
  /** Exact immutable revision bytes decoded as text, for delivery without rereading the live file. */
  workingContextText: string;
  /** Committed revision (0 = nothing committed yet). */
  revision: number;
  /** The stored cause of this revision, absent for old snapshots without that metadata. */
  revisionKind?: 'init' | 'model-edit' | 'runner-append' | 'native-compaction';
  /** Runner-neutral turns parsed from the committed revision. */
  turns: Turn[];
  /** Size of the committed revision, in characters. */
  chars: number;
  receipt?: Receipt;
  /** Present when the session was opened with a budget: where the Working Context stands against it. */
  budget?: BudgetReport;
}

export interface Session {
  readonly workingContextPath: string;
  readonly stateDir: string;
  /**
   * A random id made once per session and kept in its private state directory. An Adapter marks
   * the frames it builds with it, so text that merely looks like a frame (a quoted example) is
   * never taken for one.
   */
  readonly frameKey: string;
  /** Commits a model edit as a new revision, or restores HEAD if the file is unusable. */
  sync(): SyncResult;
  /** Confirm a returned recovery notice after a transport has completed its output write. */
  confirmReceiptReturn(): void;
  /** Syncs and commits events. An optional UUID deduplicates retries of the same retained events. */
  record(events: RunnerEvent[], options?: { maxBytes?: number; operationId?: string }): SyncResult;
  /**
   * The runner's own compaction replaced the conversation (the Compaction-only fallback, taken when
   * the Working Context alone is over its budget): syncs, applies the credential-retention policy, logs the runner's result
   * (write-ahead), and commits it, rendered as turn blocks, as the whole next Revision (kind
   * `native-compaction`). The Event Log records the delivery as COMPACTION_ONLY_FALLBACK.
   */
  nativeCompaction(events: RunnerEvent[]): SyncResult;
  /** Releases the shared lock and invalidates every facade using that lock generation. Reopen to continue. */
  close(): void;
}

export type OpenResult = { status: 'open'; session: Session } | { status: 'refused'; holder: LockHolder };

interface Head {
  rev: number;
  sha: string;
  parent: string | null;
  through: number;
  /** Identity of the durable event-log boundary written before this HEAD. */
  prepared?: string;
  materialized: boolean;
  /** What made this revision (absent in HEADs written before it was recorded). */
  kind?: CommitKind;
}

type CommitKind = 'init' | 'model-edit' | 'runner-append' | 'native-compaction';

/** A logged batch that replaces the Working Context instead of appending to it. */
interface Replacement {
  kind: 'native-compaction';
  reason: 'over-budget';
  approxTokensBefore: number;
  budgetTokens: number | null;
}

type Pending = { seq: number; event: RunnerEvent; replace?: Replacement };

/**
 * The operation index records the identified runner-events rows of the Event Log in 64 shard files,
 * chosen by a digest of the operation ID. Its head names the log file it belongs to, the log offset
 * it is complete through, and the committed length and SHA-256 digest of each shard. A lookup reads
 * the head and one shard, trusts a miss only when the shard matches its digest, scans only log rows
 * past that offset, and checks a hit against its own row. A missing, damaged or disagreeing index
 * is rebuilt from the whole log. An index with a shard above its bound is not kept, so lookups then
 * scan the whole log.
 */
type IndexedOperation = { sha: string; start: number; end: number };
type ShardState = { bytes: number; sha: string };
type OperationIndex = { dev: string; ino: string; through: number; shards: Record<string, ShardState> };
type OperationLookup = { hit?: IndexedOperation; index?: OperationIndex; shard?: { name: string; committed: Buffer } };
const OPERATION_HEAD = 'operations.json';
const OPERATION_SHARD = /^operations-[0-9a-f]{2}\.jsonl$/;
const OPERATION_HEAD_MAX_BYTES = 64 * 1024;
const OPERATION_SHARD_MAX_BYTES = 4 * 1024 * 1024;
/** Uncommitted bytes a shard may carry after an interrupted append. More forces a rebuild. */
const OPERATION_SHARD_SLACK_BYTES = 64 * 1024;
const digestBytes = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const OPERATION_SHARDS = Array.from({ length: 64 }, (_, n) => `operations-${n.toString(16).padStart(2, '0')}.jsonl`);
const EMPTY_SHARD_SHA = digestBytes(Buffer.alloc(0));

function operationShard(id: string): string {
  return `operations-${(parseInt(sha(id).slice(0, 2), 16) >> 2).toString(16).padStart(2, '0')}.jsonl`;
}

function loggedOperation(entry: Record<string, unknown>): { id: string; sha: string } | undefined {
  if (entry.type !== 'runner-events' || !entry.operation || typeof entry.operation !== 'object') return undefined;
  const { id, sha: digest } = entry.operation as { id?: unknown; sha?: unknown };
  return typeof id === 'string' && typeof digest === 'string' ? { id, sha: digest } : undefined;
}

function indexLine(operation: { id: string; sha: string }, row: LogRange): string {
  return JSON.stringify({ id: operation.id, sha: operation.sha, start: row.start, end: row.end }) + '\n';
}

/** The first entry for an ID in a shard's committed bytes. */
function findIndexedOperation(shard: Buffer, id: string): IndexedOperation | undefined {
  const needle = `{"id":"${id}"`;
  for (let at = shard.indexOf(needle); at >= 0; at = shard.indexOf(needle, at + 1)) {
    if (at > 0 && shard[at - 1] !== 0x0a) continue;
    const end = shard.indexOf(0x0a, at);
    const entry = JSON.parse(decoder.decode(shard.subarray(at, end < 0 ? shard.length : end))) as Record<string, unknown>;
    if (entry.id !== id || typeof entry.sha !== 'string' || !Number.isSafeInteger(entry.start) || !Number.isSafeInteger(entry.end)
        || (entry.end as number) <= (entry.start as number)) throw new Error('invalid operation index entry');
    return { sha: entry.sha, start: entry.start as number, end: entry.end as number };
  }
  return undefined;
}

const decoder = new TextDecoder('utf-8', { fatal: true });

function decode(bytes: Buffer): string | null {
  try {
    return decoder.decode(bytes);
  } catch {
    return null;
  }
}

const RESTORE_WORDS: Record<RestoreReason, string> = {
  missing: 'the file was missing',
  empty: 'the file was empty',
  'not-utf8': 'the file was not valid UTF-8',
  'over-hard-limit': "the file was over the runner's hard limit",
  'not-a-file': 'the file was a symbolic link or a hard link, which is never read',
  'unmaterialized-append': 'committed runner events had not yet been written to the file',
};

export function openSession(opts: OpenOptions): OpenResult {
  if (!Number.isSafeInteger(opts.hardLimit) || opts.hardLimit <= 0) throw new Error('hardLimit must be a positive safe integer of characters');
  if (opts.budgetTokens !== undefined && (!Number.isFinite(opts.budgetTokens) || opts.budgetTokens <= 0)) throw new Error('budgetTokens must be a positive number of tokens');
  if (opts.ownerPid !== undefined && (!Number.isSafeInteger(opts.ownerPid) || opts.ownerPid <= 0)) throw new Error('ownerPid must be a positive safe integer');
  const stateRoot = resolveStateRoot(opts.stateDir);
  const l = layout(opts.projectRoot, opts.sessionId, stateRoot);
  ensureDirs(l, stateRoot);
  const me = holderFor(opts.ownerPid ?? process.pid, opts.runner, opts.hardLimit);
  const got = acquireLock(l.lock, me);
  if (got.status === 'refused') return { status: 'refused', holder: got.holder };
  try {
    const published = readLock(l.lock);
    if (!published || published === 'unreadable' || !published.generation || published.pid !== me.pid || published.hostname !== me.hostname || published.startMarker !== me.startMarker) throw new Error('session lock ownership changed during open');
    const core = new Core(l, opts.hardLimit, published, experimentOn('stale-refs', opts.experiments) ? opts.projectRoot : null, opts.budgetTokens ?? null);
    core.recover();
    if (got.takeoverFrom) appendLog(l.events, { type: 'lock-takeover', from: got.takeoverFrom, to: me, reason: 'previous holder is dead' });
    return { status: 'open', session: core.facade() };
  } catch (e) {
    if (!got.reused) releaseLock(l.lock, me);
    throw e;
  }
}

/**
 * Runs `fn` as one serialized operation on the session: concurrent operations on the same session
 * (separate processes presenting the same lock owner, e.g. a runner's parallel hooks) run one at a
 * time. Creates the session's private state directory if needed. Throws SerializeTimeout when
 * another live call holds the session too long.
 */
export function withSessionSerialized<T>(ref: { projectRoot: string; sessionId: string; stateDir?: string }, fn: () => T): T {
  const stateRoot = resolveStateRoot(ref.stateDir);
  const l = layout(ref.projectRoot, ref.sessionId, stateRoot);
  ensureDirs(l, stateRoot);
  return serialized(`${l.lock}.op`, fn);
}

export interface SessionStatus {
  /** Committed revision (0 = nothing committed yet). */
  revision: number;
  /** Size of the committed revision, in characters. */
  chars: number;
  workingContext: string;
  stateDir: string;
  /** Current lock holder, with whether it is alive, or null if the session is not open. */
  lock: (LockHolder & { live: boolean }) | null;
  /** What made the committed revision: 'native-compaction' means the last compaction was Compaction-only. Null when unknown. */
  revisionKind: CommitKind | null;
}

/** Read-only view of a session. Takes no lock, runs no recovery, creates nothing. */
export function inspectSession(opts: { projectRoot: string; sessionId: string; stateDir?: string }): SessionStatus {
  const l = layout(opts.projectRoot, opts.sessionId, resolveStateRoot(opts.stateDir));
  const rawHead = readHead(l.head);
  const head = decodeHead(rawHead);
  const text = head ? readSnapshot(l,head) : '';
  const holder = readLock(l.lock);
  return {
    revision: head?.rev ?? 0,
    chars: text.length,
    workingContext: l.workingContext,
    stateDir: l.stateDir,
    lock: holder && holder !== 'unreadable' ? { ...holder, live: isAlive(holder) } : null,
    revisionKind: head?.kind ?? null,
  };
}

// HEAD contains fixed-size hashes and counters; reject corrupt metadata before allocation.
function readHead(path: string): Buffer | undefined { return readBytes(path, 4096); }
/** Independent corruption bound; legitimate runner appends can exceed the model edit limit. */
export const SNAPSHOT_MAX_BYTES = 64 * 1024 * 1024;

function boundaryIdentity(head: Pick<Head, 'rev' | 'sha' | 'parent' | 'through' | 'kind'>): string {
  return sha(JSON.stringify([head.rev, head.sha, head.parent, head.through, head.kind]));
}

function decodeHead(raw: Buffer | undefined): Head | null {
  if(!raw)return null;
  const head=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw)) as Head;
  if(!head || Array.isArray(head) || !Number.isSafeInteger(head.rev) || head.rev<1 || typeof head.sha!=='string' || !/^[a-f0-9]{64}$/.test(head.sha) || !Number.isSafeInteger(head.through) || head.through<0 || typeof head.materialized!=='boolean' || !(head.parent===null || typeof head.parent==='string'&&/^[a-f0-9]{64}$/.test(head.parent)) || !(head.kind===undefined || ['init','model-edit','runner-append','native-compaction'].includes(head.kind)))throw new Error('invalid private-state HEAD');
  if (head.prepared !== undefined && head.prepared !== boundaryIdentity(head)) throw new Error('HEAD through or revision metadata conflicts with its prepared boundary');
  return head;
}
function readSnapshot(l: Layout,head: Head): string {
  const bytes=readBytes(join(l.revisions,`${head.rev}.md`), SNAPSHOT_MAX_BYTES);
  if(!bytes)throw new Error(`revision ${head.rev} snapshot is missing`);
  const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
  if(sha(text)!==head.sha)throw new Error(`revision ${head.rev} snapshot checksum mismatch`);
  return text;
}

class Core {
  private lastSeq = 0;
  /** Events in the Event Log that no committed revision includes yet. */
  private unapplied: Pending[] = [];
  private pendingReceipt: Receipt | undefined;
  private closed = false;
  private unloggedCommit: { head: Head; text: string } | undefined;
  private appendUncertain=false;
  private recoveryReceiptHeads: Array<{rev:number;sha:string}> = [];
  /** The operation index as of this call's lookup, extended by the row the call appends. */
  private operationIndex: OperationLookup | undefined;
  // Acknowledgements are confirmed only on a later call, after the result returned.
  private returnedReceiptHeads: Array<{rev:number;sha:string}> = [];
  private readonly l: Layout;
  private readonly hardLimit: number;
  private readonly me: LockHolder;
  /** Project root to check stale-reference markers against, or null when the experiment is off. */
  private readonly refsRoot: string | null;
  /** The Working Context's budget in tokens, or null when the adapter gave none. */
  private readonly budgetTokens: number | null;
  /** What the budget checks remember; rebuilt from the Event Log at recovery, then kept current. */
  private memory: BudgetMemory = { announced: 0, growth: [], lastTokens: 0, loggedBudget: null };

  constructor(l: Layout, hardLimit: number, me: LockHolder, refsRoot: string | null, budgetTokens: number | null) {
    this.l = l;
    this.hardLimit = hardLimit;
    this.me = me;
    this.refsRoot = refsRoot;
    this.budgetTokens = budgetTokens;
  }

  facade(): Session {
    return {
      workingContextPath: this.l.workingContext,
      stateDir: this.l.stateDir,
      frameKey: sessionFrameKey(this.l.stateDir),
      sync: () => this.guard(() => this.finishResult(this.sync())),
      confirmReceiptReturn: () => { this.assertOpen(); this.confirmReturnedReceipts(); this.saveRecoveryCheckpoint(); },
      record: (events, options) => this.guard(() => this.finishResult(this.record(events, false, options?.maxBytes, options?.operationId))),
      nativeCompaction: (events) => this.guard(() => this.finishResult(this.record(events, true))),
      close: () => this.close(),
    };
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('session is closed');
    try {
      const current = readLock(this.l.lock);
      if (current && current !== 'unreadable' && current.generation === this.me.generation
          && current.pid === this.me.pid && current.hostname === this.me.hostname && current.startMarker === this.me.startMarker) return;
    } catch { /* A removed or unverifiable lock invalidates this facade. */ }
    this.closed = true;
    throw new Error('session lock was released or replaced; session is closed');
  }

  private guard<T>(fn: () => T, repair = true): T {
    this.assertOpen();
    this.confirmReturnedReceipts();
    if(repair&&this.appendUncertain)throw new Error('Event Log append may have persisted; close and reopen this session before retrying');
    if (repair && this.unloggedCommit) {
      const { head, text } = this.unloggedCommit;
      const published = this.head();
      if (!published || published.rev !== head.rev || published.sha !== head.sha) this.unloggedCommit = undefined;
      else {
        const receipt = this.repairRevisionLog(head);
        if (receipt) this.retainReceipt({revision:head.rev,chars:text.length,workingContextText:text,turns:[],receipt});
        if (this.budgetTokens !== null) this.memory = budgetMemory(readLog(this.l.events), this.budgetTokens);
        if (!head.materialized) this.materialize(head, text);
        this.unloggedCommit = undefined;
      }
    }
    const result = fn();
    if (!this.closed) this.saveRecoveryCheckpoint();
    return result;
  }

  // Cache only fully applied recovery state. It is an optimization, never the
  // source of truth: changed log identity/size/timestamps, HEAD or budget,
  // missing/corrupt cache and interrupted publication all take the full rebuild.
  private checkpointLog(): object | null {
    try {
      const st = statSync(this.l.events, { bigint: true });
      if (!st.isFile() || st.nlink !== 1n) return null;
      return { dev: String(st.dev), ino: String(st.ino), size: String(st.size), mtime: String(st.mtimeNs), ctime: String(st.ctimeNs) };
    } catch { return null; }
  }

  private loadRecoveryCheckpoint(): boolean {
    try {
      const raw = readBytes(join(this.l.stateDir, 'recovery.json'), 4096);
      if (!raw || raw.length > 4096) return false;
      const c = JSON.parse(raw.toString('utf8'));
      const { checksum, ...payload } = c;
      if (checksum !== sha(JSON.stringify(payload))) return false;
      const head = this.head();
      const log = this.checkpointLog();
      const m = c.memory;
      const nonnegative = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
      if (c.version !== 3 || !log || JSON.stringify(c.log) !== JSON.stringify(log) || c.head !== sha(readHead(this.l.head)?.toString('utf8') ?? '') || c.budget !== this.budgetTokens || !nonnegative(c.lastSeq) || c.lastSeq !== (head?.through ?? 0) || !m || ![0,25,50,75].includes(m.announced) || !Array.isArray(m.growth) || m.growth.length > 3 || !m.growth.every(nonnegative) || !nonnegative(m.lastTokens) || !(m.loggedBudget === null || (nonnegative(m.loggedBudget) && m.loggedBudget > 0))) return false;
      this.lastSeq = c.lastSeq;
      this.memory = { announced: m.announced, growth: [...m.growth], lastTokens: m.lastTokens, loggedBudget: m.loggedBudget };
      return true;
    } catch { return false; }
  }

  private saveRecoveryCheckpoint(): void {
    if(this.appendUncertain)return;
    try {
      const head = this.head();
      const log = this.checkpointLog();
      if (!log || this.unloggedCommit || this.recoveryReceiptHeads.length || this.returnedReceiptHeads.length || this.unapplied.length || this.lastSeq !== (head?.through ?? 0)) return;
      const payload = { version: 3, log, head: sha(readHead(this.l.head)?.toString('utf8') ?? ''), budget: this.budgetTokens, lastSeq: this.lastSeq, memory: this.memory };
      atomicWrite(join(this.l.stateDir, 'recovery.json'), JSON.stringify({ ...payload, checksum: sha(JSON.stringify(payload)) }), 'recovery-checkpoint-tmp');
    } catch { /* A cache failure never changes the session result; next open rebuilds. */ }
  }

  // ---- reading ----

  private head(): Head | null {
    const raw = readHead(this.l.head);
    return decodeHead(raw);
  }

  private snapshot(rev: number): string {
    const head=this.head();
    if(!head || head.rev!==rev)throw new Error('snapshot revision does not match HEAD');
    return readSnapshot(this.l,head);
  }

  private result(head: Head | null, receipt?: Receipt): SyncResult {
    const text = head ? this.snapshot(head.rev) : '';
    const r: SyncResult = { revision: head?.rev ?? 0, ...(head?.kind ? { revisionKind: head.kind } : {}), turns: parseTurns(text), chars: text.length, workingContextText: text };
    if (receipt) r.receipt = receipt;
    return r;
  }

  /** Latch notices before fallible postchecks; retain recovery notices beside newer receipts. */
  private retainReceipt(r: SyncResult): SyncResult {
    const pending = this.pendingReceipt;
    if (!r.receipt && pending) r.receipt = pending;
    else if (pending && r.receipt && r.receipt !== pending && !r.receipt.text.includes(pending.text)) {
      r.receipt = { ...pending, text: `${pending.text}\n${r.receipt.text}`, ...(r.receipt.stale ? { stale: r.receipt.stale } : {}) };
    }
    this.pendingReceipt = r.receipt;
    return r;
  }

  private confirmReturnedReceipts(): void {
    while (this.returnedReceiptHeads.length) {
      appendLog(this.l.events, {type:'revision-receipt-return-confirmed',...this.returnedReceiptHeads[0]});
      this.returnedReceiptHeads.shift();
    }
  }

  private deliver(r: SyncResult): SyncResult {
    const batch=[...this.recoveryReceiptHeads];
    for (const head of batch) {
      appendLog(this.l.events, {type:'revision-receipt-delivery-intent',...head});
      appendLog(this.l.events, {type:'revision-receipt-delivered',...head});
      }
    // No notice is confirmable if any acknowledgement in the result batch failed.
    this.returnedReceiptHeads.push(...batch);
    this.recoveryReceiptHeads=[];
    this.pendingReceipt = undefined;
    return r;
  }

  private finishResult(r: SyncResult): SyncResult {
    return this.deliver(this.checkBudget(this.checkRefs(this.retainReceipt(r))));
  }

  /** Stale-refs experiment: adds stale cited references in the committed revision to the receipt. */
  private checkRefs(r: SyncResult): SyncResult {
    if (this.refsRoot === null || r.revision === 0) return r;
    const stale = checkRefs(this.refsRoot, this.snapshot(r.revision));
    if (!stale) return r;
    const text = staleText(stale);
    r.receipt = r.receipt
      ? { ...r.receipt, text: `${r.receipt.text}\n${text}`, stale }
      : { kind: 'stale', revision: r.revision, chars: r.chars, approxTokens: approxTokens(r.chars), text: `${text} ${sizeReadout(r.chars)}`, stale };
    return r;
  }

  /** With a budget: adds the readout and any reminder it fires to the result, and logs a fired reminder. */
  private checkBudget(r: SyncResult): SyncResult {
    if (this.budgetTokens === null) return r;
    if (this.memory.loggedBudget !== this.budgetTokens) {
      // The budget in force, whenever it changes (Claude's moves with its auto-compact threshold).
      appendLog(this.l.events, { type: 'budget', budgetTokens: this.budgetTokens });
      this.memory.loggedBudget = this.budgetTokens;
    }
    const report = checkBudget(this.memory, r.chars, this.budgetTokens);
    if (report.tier || report.urgent) {
      appendLog(this.l.events, {
        type: 'budget-reminder',
        tier: report.tier,
        urgent: report.urgent,
        overBudget: report.overBudget,
        approxTokens: report.approxTokens,
        budgetTokens: report.budgetTokens,
        rev: r.revision,
      });
      if (report.tier > this.memory.announced) this.memory.announced = report.tier;
    }
    r.budget = report;
    return r;
  }

  // ---- writing ----

  private commit(text: string, kind: CommitKind, through?: number): Head {
    if (Buffer.byteLength(text, 'utf8') > SNAPSHOT_MAX_BYTES) throw new Error('revision snapshot exceeds the 64 MiB publication limit');
    const prev = this.head();
    if (prev?.rev === Number.MAX_SAFE_INTEGER) throw new Error('revision counter exhausted; start a new session');
    const rev = (prev?.rev ?? 0) + 1;
    atomicWrite(join(this.l.revisions, `${rev}.md`), text, 'snapshot-tmp');
    crashPoint('before-head');
    const materialize = kind === 'runner-append' || kind === 'native-compaction';
    const head: Head = { rev, sha: sha(text), parent: prev?.sha ?? null, through: through ?? prev?.through ?? 0, materialized: !materialize, kind };
    head.prepared = boundaryIdentity(head);
    // This witness must survive even if final revision accounting is interrupted.
    try { appendLog(this.l.events, { type: 'revision-prepared', rev, sha: head.sha, parent: head.parent, kind, through: head.through, prepared: head.prepared }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'CE_LOG_APPEND_AMBIGUOUS') this.appendUncertain = true; throw error; }
    this.unloggedCommit = { head, text };
    atomicWrite(this.l.head, JSON.stringify(head), 'head-tmp');
    appendLog(this.l.events, { type: 'revision', rev, kind, sha: head.sha, chars: text.length, through: head.through, prepared: head.prepared });
    this.unloggedCommit = undefined;
    if (this.budgetTokens !== null) remember(this.memory, kind, text.length, this.budgetTokens);
    if (materialize) this.materialize(head, text);
    return head;
  }

  /**
   * Writes committed text over the Working Context. A file that is neither the parent this revision
   * was built on nor the new text holds an edit made since the last sync, or while the adapter was
   * down. It is not committed over the append. It is kept in the Event Log with a restore receipt.
   * replaceWorkingContext() says which edits can still be overwritten unseen.
   */
  private materialize(head: Head, text: string): void {
    crashPoint('before-wc');
    const kept = new Set<string>();
    const bound = Math.min(SNAPSHOT_MAX_BYTES, Math.max(this.hardLimit * 4, statSync(join(this.l.revisions, `${head.rev}.md`)).size));
    replaceWorkingContext(this.l.workingContext, text, bound, (read) => this.keepStaleEdit(head, text.length, read, kept));
    head.materialized = true;
    atomicWrite(this.l.head, JSON.stringify(head), 'head-tmp');
  }

  /** Keeps one stale edit. True when it appended a row, which gave other edits time to land. */
  private keepStaleEdit(head: Head, chars: number, read: WorkingContextRead, kept: Set<string>): boolean {
    if (read === undefined) return false;
    const current = Buffer.isBuffer(read) ? decode(read) : null;
    if (current !== null && (!current.trim() || [head.parent, head.sha].includes(sha(current)))) return false;
    // Logged as sync() logs an unusable file: the text, the raw bytes, or nothing when it was not read.
    const rejected: Record<string, unknown> = current !== null ? { rejected: current }
      : Buffer.isBuffer(read) ? { rejectedBase64: read.toString('base64') }
      : { rejected: null, ...(read === 'too-large' ? { oversized: true } : {}) };
    const key = JSON.stringify(rejected);
    if (kept.has(key)) return false;
    kept.add(key);
    // A retry after a crash between this append and the rename finds the edit already kept.
    let last: Record<string, unknown> | undefined;
    for (const entry of readLog(this.l.events)) if (entry.type === 'restored' && entry.rev === head.rev) last = entry;
    const appended = !last || ['rejected', 'rejectedBase64', 'oversized'].some((k) => last[k] !== rejected[k]);
    if (appended) {
      try { appendLog(this.l.events, { type: 'restored', rev: head.rev, reason: 'unmaterialized-append', ...rejected }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'CE_LOG_APPEND_AMBIGUOUS') this.appendUncertain = true; throw error; }
    }
    const what = Buffer.isBuffer(read)
      ? 'The intervening edit is kept in the Event Log; read the restored file before editing it again.'
      : 'The intervening file was oversized or linked, so its bytes were not read or copied, and its rejection is recorded in the Event Log. Read the restored file before editing it again.';
    const receipt: Receipt = { kind: 'restored', revision: head.rev, reason: 'unmaterialized-append', chars, approxTokens: approxTokens(chars), text: `Context Engine: revision ${head.rev} was restored because committed runner events had not yet reached the Working Context. ${what} ${sizeReadout(chars)}` };
    // The restore describes the newest revision, so it leads. Earlier notices keep their text first.
    // One notice covers every edit kept for the same revision.
    const pending = this.pendingReceipt;
    if (pending?.kind !== 'restored' || pending.revision !== head.rev) this.pendingReceipt = pending ? { ...receipt, text: `${pending.text}\n${receipt.text}` } : receipt;
    return appended;
  }

  private writeWorkingContext(text: string): void {
    assertWorkingContextDir(this.l.workingContext);
    atomicWrite(this.l.workingContext, text, 'wc-tmp');
  }

  private invalid(bytes: Buffer | undefined | 'not-a-file' | 'too-large'): { reason: RestoreReason; text: string | null } | { text: string } {
    if (bytes === 'too-large') return { reason: 'over-hard-limit', text: null };
    if (bytes === 'not-a-file') return { reason: 'not-a-file', text: null };
    if (bytes === undefined) return { reason: 'missing', text: null };
    const text = decode(bytes);
    if (text === null) return { reason: 'not-utf8', text: null };
    if (text.trim() === '') return { reason: 'empty', text };
    if (text.length > this.hardLimit) return { reason: 'over-hard-limit', text };
    return { text };
  }

  sync(): SyncResult {
    const head = this.head();
    // Runner appends may legitimately exceed the edit limit; recognize that existing snapshot.
    const bound = Math.min(SNAPSHOT_MAX_BYTES, Math.max(this.hardLimit * 4, head ? statSync(join(this.l.revisions, `${head.rev}.md`)).size : 0));
    const read = readWorkingContextFile(this.l.workingContext, bound);
    const bytes = typeof read === 'string' ? undefined : read;
    // The file is the committed revision itself: nothing was edited, so nothing can be rejected
    // (a runner append may have taken HEAD past the hard limit; that is the budget's business).
    if (head && bytes && head.materialized && sha(bytes.toString('utf8')) === head.sha && decode(bytes) !== null) return this.result(head);
    const check = this.invalid(read);

    if ('reason' in check) {
      if (!head) return this.result(null, this.rejectWithoutHead(check, bytes));
      const restored = this.snapshot(head.rev);
      const rejected: Record<string, unknown> =
        check.text !== null ? { rejected: check.text } : bytes ? { rejectedBase64: bytes.toString('base64') } : { rejected: null };
      appendLog(this.l.events, { type: 'restored', rev: head.rev, reason: check.reason, ...rejected });
      this.writeWorkingContext(restored);
      const receipt: Receipt = {
        kind: 'restored',
        revision: head.rev,
        reason: check.reason,
        chars: restored.length,
        approxTokens: approxTokens(restored.length),
        text: `Context Engine: your Working Context edit was not applied (${RESTORE_WORDS[check.reason]}). Revision ${head.rev} (${restored.length} chars) was restored; ${read === 'too-large' ? 'oversized bytes were not read or copied; the rejection is recorded in the Event Log' : 'the rejected text is kept in the Event Log'}. ${sizeReadout(restored.length)}`,
      };
      return this.result(head, receipt);
    }

    if (!head) return this.result(this.commit(check.text, 'init'));
    if (sha(check.text) === head.sha) return this.result(head);
    const previousChars = this.snapshot(head.rev).length;
    const next = this.commit(check.text, 'model-edit');
    const receipt: Receipt = {
      kind: 'committed',
      revision: next.rev,
      previousChars,
      chars: check.text.length,
      approxTokens: approxTokens(check.text.length),
      text: `Context Engine: Working Context edit committed as revision ${next.rev} (${previousChars} -> ${check.text.length} chars). ${sizeReadout(check.text.length)}`,
    };
    return this.result(next, receipt);
  }

  record(events: RunnerEvent[], replace = false, maxBytes = SNAPSHOT_MAX_BYTES, operationId?: string): SyncResult {
    const stringField = (event: unknown, key: string): string | undefined => {
      if (!event || typeof event !== 'object') return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(event, key);
      return descriptor?.enumerable && 'value' in descriptor && typeof descriptor.value === 'string' ? descriptor.value : undefined;
    };
    let dense=Array.isArray(events);
    if(dense)for(let i=0;i<events.length;i++){
      const slot=Object.getOwnPropertyDescriptor(events,i);
      if(!slot||!('value' in slot)||stringField(slot.value,'role')===undefined||stringField(slot.value,'text')===undefined){dense=false;break;}
    }
    if (!dense) {
      throw new Error(`${replace ? 'nativeCompaction' : 'record'}() takes an array of { role: string, text: string } events`);
    }
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > SNAPSHOT_MAX_BYTES) throw new Error('invalid revision snapshot byte limit');
    if (replace && events.every((e) => stringField(e, 'text')!.trim() === '')) throw new Error('nativeCompaction() needs the runner result: at least one non-empty event');
    if (operationId !== undefined && (typeof operationId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(operationId))) throw new Error('invalid record operation identifier');
    const retained = events.map(retainRunnerEvent);
    const operation = operationId === undefined ? undefined : { id: operationId, sha: sha(JSON.stringify(retained)) };
    const synced = this.retainReceipt(this.sync());
    if (operation) {
      // Identity and events share one durable row, including during replay after a failed return.
      const recorded = this.findOperation(operation.id);
      if (recorded) {
        if (recorded.sha !== operation.sha) throw new Error('record operation identifier was used for different input');
        return this.result(this.apply(), this.pendingReceipt);
      }
    }
    if (events.length === 0) return synced;
    this.lastSeq = Math.max(this.lastSeq, this.head()?.through ?? 0);
    if (retained.length > Number.MAX_SAFE_INTEGER - this.lastSeq) throw new Error('Event Log sequence exhausted; start a new session');
    if (this.head()?.rev === Number.MAX_SAFE_INTEGER) throw new Error('revision counter exhausted; start a new session');
    const numbered: Pending[] = retained.map((event, i) => ({ seq: this.lastSeq + i + 1, event }));
    const replacement: Replacement | undefined = replace
      ? { kind: 'native-compaction', reason: 'over-budget', approxTokensBefore: approxTokens(synced.chars), budgetTokens: this.budgetTokens }
      : undefined;
    const preview=numbered.map(p=>({...p}));
    if(replacement)preview[0]!.replace=replacement;
    const previewHead=this.head();
    const prospective = this.renderPending([...this.unapplied, ...preview].filter(p=>p.seq>(previewHead?.through??0)),previewHead);
    if (Buffer.byteLength(prospective.text, 'utf8') > maxBytes) throw new Error(`revision snapshot exceeds the ${maxBytes === SNAPSHOT_MAX_BYTES ? '64 MiB' : maxBytes+' byte'} publication limit`);
    let row: LogRange;
    try {row=appendLog(this.l.events, { type: 'runner-events', events: numbered, ...(operation ? { operation } : {}), ...(replacement ? { replace: replacement } : {}) });}
    catch(e) {if((e as NodeJS.ErrnoException).code==='CE_LOG_APPEND_AMBIGUOUS')this.appendUncertain=true;throw e;}
    this.lastSeq += numbered.length;
    if (replacement) numbered[0]!.replace = replacement;
    this.unapplied.push(...numbered);
    crashPoint('after-log');
    if (operation) this.indexOperation(operation, row);
    const head = this.apply();
    // The sync receipt, plus any edit that raced the append (see materialize).
    const r = this.result(head);
    if (this.pendingReceipt) r.receipt = this.pendingReceipt;
    return r;
  }

  private logIdentity(): { dev: string; ino: string; size: number } | undefined {
    try {
      const st = statSync(this.l.events, { bigint: true });
      return { dev: String(st.dev), ino: String(st.ino), size: Number(st.size) };
    } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e; }
  }

  /** Finds the first row of an operation ID without reading the whole Event Log in the normal path. */
  private findOperation(id: string): IndexedOperation | undefined {
    let found = this.searchOperationIndex(id);
    if (found?.hit && !this.operationRowMatches(id, found.hit)) found = undefined;
    found ??= this.rebuildOperationIndex(id);
    this.operationIndex = found;
    return found.hit;
  }

  /** The head, when it belongs to this log file and covers no more than its length. */
  private readOperationHead(log: { dev: string; ino: string; size: number }): OperationIndex | undefined {
    const bytes = readBytes(join(this.l.stateDir, OPERATION_HEAD), OPERATION_HEAD_MAX_BYTES);
    if (!bytes) return undefined;
    const head = JSON.parse(decoder.decode(bytes)) as Record<string, unknown>;
    if (head.type !== 'operation-index' || head.version !== 3 || head.dev !== log.dev || head.ino !== log.ino) return undefined;
    if (!Number.isSafeInteger(head.through) || (head.through as number) < 0 || (head.through as number) > log.size) return undefined;
    const shards = head.shards as Record<string, { bytes?: unknown; sha?: unknown }> | undefined;
    if (!shards || typeof shards !== 'object' || Array.isArray(shards)) return undefined;
    // Every bucket has a commitment, so a missing entry cannot masquerade as an empty shard.
    if (Object.keys(shards).length !== OPERATION_SHARDS.length || OPERATION_SHARDS.some(name => !Object.hasOwn(shards, name))) return undefined;
    for (const [name, state] of Object.entries(shards)) {
      if (!OPERATION_SHARD.test(name) || !state || !Number.isSafeInteger(state.bytes) || (state.bytes as number) < 0
          || (state.bytes as number) > OPERATION_SHARD_MAX_BYTES || typeof state.sha !== 'string' || !/^[0-9a-f]{64}$/.test(state.sha)) return undefined;
      if (state.bytes === 0 && state.sha !== EMPTY_SHARD_SHA) return undefined;
    }
    return { dev: log.dev, ino: log.ino, through: head.through as number, shards: shards as Record<string, ShardState> };
  }

  /** A shard's committed bytes, or undefined unless they match the head's length and digest. */
  private readOperationShard(index: OperationIndex, name: string): Buffer | undefined {
    const state = index.shards[name];
    if (!state) return undefined;
    if (state.bytes === 0) return Buffer.alloc(0);
    const file = readBytes(join(this.l.stateDir, name), state.bytes + OPERATION_SHARD_SLACK_BYTES);
    if (!file || file.length < state.bytes) return undefined;
    // An omitted, replaced or reordered entry changes the digest, so a miss is never trusted then.
    const committed = file.subarray(0, state.bytes);
    return digestBytes(committed) === state.sha ? committed : undefined;
  }

  /** Appends whole lines after a shard's committed bytes and returns its new committed bytes. */
  private appendOperationShard(index: OperationIndex, name: string, committed: Buffer, lines: string): Buffer {
    const added = Buffer.from(lines);
    if (committed.length + added.length > OPERATION_SHARD_MAX_BYTES) throw new Error('operation index shard exceeds its size bound');
    appendCommitted(join(this.l.stateDir, name), committed.length, added);
    const grown = Buffer.concat([committed, added]);
    index.shards[name] = { bytes: grown.length, sha: digestBytes(grown) };
    return grown;
  }

  private writeOperationHead(index: OperationIndex): void {
    const head = { type: 'operation-index', version: 3, dev: index.dev, ino: index.ino, through: index.through, shards: index.shards };
    atomicWrite(join(this.l.stateDir, OPERATION_HEAD), JSON.stringify(head), 'operation-index-tmp');
  }

  /** Searches one shard, then indexes log rows past the covered offset. Undefined when the index cannot be used. */
  private searchOperationIndex(id: string): OperationLookup | undefined {
    try {
      const log = this.logIdentity();
      const index = log && this.readOperationHead(log);
      if (!log || !index) return undefined;
      const name = operationShard(id);
      let committed = this.readOperationShard(index, name);
      if (!committed) return undefined;
      let hit = findIndexedOperation(committed, id);
      if (index.through < log.size) {
        const pending = new Map<string, string>();
        let through = index.through;
        for (const row of readLogRows(this.l.events, index.through)) {
          const operation = loggedOperation(row.entry);
          if (operation) {
            if (!hit && operation.id === id) hit = { sha: operation.sha, start: row.start, end: row.end };
            const target = operationShard(operation.id);
            pending.set(target, (pending.get(target) ?? '') + indexLine(operation, row));
          }
          through = row.end;
        }
        // Identified rows logged past the offset, as after a crash before indexing, enter their shards.
        for (const [target, lines] of pending) {
          const base = target === name ? committed : this.readOperationShard(index, target);
          if (!base) return undefined;
          const grown = this.appendOperationShard(index, target, base, lines);
          if (target === name) committed = grown;
        }
        if (through !== index.through) {
          index.through = through;
          this.writeOperationHead(index);
        }
      }
      return { hit, index, shard: { name, committed } };
    } catch { return undefined; }
  }

  /** A hit must name its own complete row, so the index never stands in for log data. */
  private operationRowMatches(id: string, hit: IndexedOperation): boolean {
    try {
      for (const row of readLogRows(this.l.events, hit.start)) {
        const operation = loggedOperation(row.entry);
        return row.end === hit.end && operation?.id === id && operation.sha === hit.sha;
      }
    } catch { /* A range that does not start a record disagrees with the log. */ }
    return false;
  }

  /** Recovery path: one full Event Log scan, then fresh shards and head. An index too large to keep is removed. */
  private rebuildOperationIndex(id: string): OperationLookup {
    const log = this.logIdentity();
    if (!log) return {};
    const shards = new Map<string, string[]>(), sizes = new Map<string, number>();
    let hit: IndexedOperation | undefined, through = 0, kept = true;
    for (const row of readLogRows(this.l.events)) {
      const operation = loggedOperation(row.entry);
      if (operation) {
        if (!hit && operation.id === id) hit = { sha: operation.sha, start: row.start, end: row.end };
        if (kept) {
          const name = operationShard(operation.id), line = indexLine(operation, row), size = (sizes.get(name) ?? 0) + line.length;
          if (size > OPERATION_SHARD_MAX_BYTES) { kept = false; shards.clear(); }
          else {
            sizes.set(name, size);
            const lines = shards.get(name);
            if (lines) lines.push(line); else shards.set(name, [line]);
          }
        }
      }
      through = row.end;
    }
    try {
      // The head goes first and returns last, so an interrupted rebuild leaves no index to trust.
      removeDirectoryEntries(this.l.stateDir, name => name === OPERATION_HEAD || (OPERATION_SHARD.test(name) && !shards.has(name)));
      if (!kept) return { hit };
      const index: OperationIndex = { dev: log.dev, ino: log.ino, through,
        shards: Object.fromEntries(OPERATION_SHARDS.map(name => [name, { bytes: 0, sha: EMPTY_SHARD_SHA }])) };
      const contents = new Map<string, Buffer>();
      for (const [name, lines] of shards) {
        const bytes = Buffer.from(lines.join(''));
        atomicWrite(join(this.l.stateDir, name), bytes.toString('utf8'), 'operation-index-tmp');
        index.shards[name] = { bytes: bytes.length, sha: digestBytes(bytes) };
        contents.set(name, bytes);
      }
      this.writeOperationHead(index);
      const name = operationShard(id);
      return { hit, index, shard: { name, committed: contents.get(name) ?? Buffer.alloc(0) } };
    } catch { return { hit }; }
  }

  /** Extends the index with this call's own row when the index reaches exactly to its start. */
  private indexOperation(operation: { id: string; sha: string }, row: LogRange): void {
    const found = this.operationIndex;
    this.operationIndex = undefined;
    if (!found?.index || !found.shard || found.index.through !== row.start) return;
    try {
      this.appendOperationShard(found.index, found.shard.name, found.shard.committed, indexLine(operation, row));
      found.index.through = row.end;
      this.writeOperationHead(found.index);
    } catch { /* The next lookup scans the Event Log from the last covered offset. */ }
  }

  /**
   * Renders logged-but-unapplied events onto HEAD and commits them. Normal path and replay alike. A
   * replacing batch (a native compaction) starts the text over from its own events.
   */
  private apply(): Head | null {
    const head = this.head();
    const fresh = this.unapplied.filter((p) => p.seq > (head?.through ?? 0));
    if (fresh.length === 0) return head;
    const {text,replaced} = this.renderPending(fresh,head);
    const next = this.commit(text, replaced ? 'native-compaction' : 'runner-append', fresh.at(-1)!.seq);
    this.unapplied = [];
    if (replaced) appendLog(this.l.events, { type: 'delivery', mode: COMPACTION_ONLY_FALLBACK.label, rev: next.rev, ...replaced });
    return next;
  }

  private renderPending(fresh: Pending[], head: Head | null): { text: string; replaced?: Replacement } {
    let text = head ? this.snapshot(head.rev).replace(/\s+$/, '') : '';
    let replaced: Replacement | undefined;
    for (let i = 0; i < fresh.length; ) {
      if (fresh[i]!.replace) {
        replaced = fresh[i]!.replace;
        text = '';
      }
      let j = i + 1;
      while (j < fresh.length && !fresh[j]!.replace) j++;
      const blocks = renderTurns(
        fresh.slice(i, j).map((p) => p.event),
        countHeaders(text) + 1,
      );
      text = text ? `${text}\n\n${blocks}` : blocks;
      i = j;
    }
    return {text,replaced};
  }

  /** Without a revision, invalid entries are logged and preserved for explicit user repair. */
  private rejectWithoutHead(check: { reason: RestoreReason; text: string | null }, bytes: Buffer | undefined): Receipt | undefined {
    if (check.reason === 'over-hard-limit' && bytes === undefined) {
      appendLog(this.l.events, { type: 'restored', rev: 0, reason: check.reason, rejected: null, oversized: true });
      throw new Error('Context Engine: oversized Working Context bytes were not read or copied; no revision exists to restore and the file was preserved. Repair it or remove that exact entry yourself before retrying.');
    }
    if (check.reason === 'not-a-file') {
      // Preserve the entry: no portable inode-conditional unlink can protect a concurrent replacement.
      appendLog(this.l.events, { type: 'restored', rev: 0, reason: check.reason, rejected: null });
      throw new Error('Context Engine: unusable Working Context has no revision to restore; file preserved. Repair it or remove that exact entry yourself before retrying.');
    }
    if (bytes === undefined || check.reason === 'empty') return undefined;
    appendLog(this.l.events, {
      type: 'restored',
      rev: 0,
      reason: check.reason,
      ...(check.text !== null ? { rejected: check.text } : { rejectedBase64: bytes.toString('base64') }),
    });
    throw new Error('Context Engine: unusable Working Context has no revision to restore; file preserved. Repair it or remove that exact entry yourself before retrying.');
  }

  close(): void {
    this.assertOpen();
    let failed = false;
    try {
      this.confirmReturnedReceipts();
      appendLog(this.l.events, { type: 'closed', pid: this.me.pid });
      this.saveRecoveryCheckpoint();
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      try { releaseLock(this.l.lock, this.me); }
      catch (error) { if (!failed) throw error; }
      finally { this.closed = true; }
    }
  }

  // ---- recovery: the same code paths as normal operation ----

  /** HEAD is already committed: repair missing accounting before checkpoint/budget recovery. */
  private repairRevisionLog(head: Head | null): Receipt | undefined {
    let logged = false, committed: string | undefined;
    const pending = new Map<string, {rev:number;sha:string;kind:CommitKind;chars:number}>();
    const attempted = new Set<string>();
    const snapshot = () => committed ??= this.snapshot(head!.rev);
    // Scan even without HEAD so cross-record corruption is refused before materialization.
    for (const entry of readLog(this.l.events)) {
      if (head && entry.type === 'revision' && entry.rev === head.rev && entry.sha === head.sha) {
        if (head.kind && (entry.kind !== head.kind || entry.chars !== snapshot().length)) throw new Error('committed revision accounting metadata conflicts with HEAD; refusing recovery');
        if (entry.through !== undefined && entry.through !== head.through) throw new Error('committed revision accounting through conflicts with HEAD; refusing recovery');
        if (entry.prepared !== undefined && entry.prepared !== head.prepared) throw new Error('committed revision accounting identity conflicts with HEAD; refusing recovery');
        logged = true;
      }
      if (entry.type === 'revision' && entry.recovered === true) {
        if (!head || !Number.isSafeInteger(entry.rev) || Number(entry.rev) < 1 || Number(entry.rev) > head.rev || typeof entry.sha !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha) || !['init','model-edit','runner-append','native-compaction'].includes(String(entry.kind)) || !Number.isSafeInteger(entry.chars) || Number(entry.chars) < 0) throw new Error('invalid recovered revision accounting; refusing recovery');
        pending.set(`${entry.rev}:${entry.sha}`, {rev:Number(entry.rev),sha:entry.sha,kind:entry.kind as CommitKind,chars:Number(entry.chars)});
      }
      const key = `${entry.rev}:${entry.sha}`;
      if (entry.type === 'revision-receipt-delivery-intent') attempted.add(key);
      // Legacy acknowledgements retain their meaning; new attempts require a later confirmation.
      if (entry.type === 'revision-receipt-return-confirmed' || (entry.type === 'revision-receipt-delivered' && !attempted.has(key))) pending.delete(key);
    }
    if (head?.kind && !logged) {
      const text = snapshot();
      const entry = {rev:head.rev,kind:head.kind,sha:head.sha,chars:text.length,through:head.through,...(head.prepared ? {prepared:head.prepared} : {})};
      appendLog(this.l.events, {type:'revision',...entry,recovered:true});
      pending.set(`${head.rev}:${head.sha}`, entry);
    }
    const receipts: Receipt[] = [];
    for (const entry of pending.values()) {
      const bytes = readBytes(join(this.l.revisions, `${entry.rev}.md`), SNAPSHOT_MAX_BYTES);
      if (!bytes) throw new Error('recovered committed snapshot missing; refusing recovery');
      const text = new TextDecoder('utf-8', {fatal:true,ignoreBOM:true}).decode(bytes);
      if (sha(text) !== entry.sha || text.length !== entry.chars) throw new Error('recovered revision accounting conflicts with its snapshot');
      let previousChars = 0;
      if (entry.rev > 1) {
        const previous = readBytes(join(this.l.revisions, `${entry.rev - 1}.md`), SNAPSHOT_MAX_BYTES);
        if (!previous) throw new Error('previous committed snapshot missing during revision-log recovery');
        const decoded = new TextDecoder('utf-8', {fatal:true,ignoreBOM:true}).decode(previous);
        if (entry.rev === head?.rev && sha(decoded) !== head.parent) throw new Error('previous committed snapshot checksum mismatch during revision-log recovery');
        previousChars = decoded.length;
      }
      receipts.push({kind:'committed',revision:entry.rev,previousChars,chars:text.length,approxTokens:approxTokens(text.length),text:`Context Engine: recovered the Event Log accounting for already committed revision ${entry.rev}. ${sizeReadout(text.length)}`});
    }
    this.recoveryReceiptHeads = [...pending.values()].map(({rev,sha}) => ({rev,sha}));
    return receipts[0] ? {...receipts[0],text:receipts.map(receipt=>receipt.text).join('\n')} : undefined;
  }

  /** Validate the commit boundary before any recovery writes, including torn-tail repair. */
  private validateHeadBoundary(head: Head | null): void {
    let prepared = false, hasPreparation = false, lastSequence = 0;
    const legacyBoundaries = new Map<number, number>();
    for (const entry of readLog(this.l.events)) {
      if (entry.type === 'runner-events') {
        const events = entry.events as Pending[];
        if (events.length) lastSequence = events.at(-1)!.seq;
      }
      if (!head) continue;
      if (entry.type === 'revision-prepared' && entry.rev === head.rev) {
        hasPreparation = true;
        if (head.prepared !== undefined && entry.prepared === head.prepared) {
          if (entry.sha !== head.sha || entry.parent !== head.parent || entry.kind !== head.kind || entry.through !== head.through) throw new Error('prepared revision accounting conflicts with HEAD');
          prepared = true;
        }
      }
      // Old normal accounting follows applied runner events. Recovered accounting
      // was reconstructed from HEAD and cannot independently corroborate it.
      if (entry.type === 'revision' && entry.recovered !== true && typeof entry.rev === 'number') {
        const boundary = entry.kind === 'runner-append' || entry.kind === 'native-compaction' ? lastSequence
          : entry.kind === 'init' ? 0 : entry.kind === 'model-edit' ? legacyBoundaries.get(entry.rev - 1) : undefined;
        if (boundary !== undefined) {
          legacyBoundaries.set(entry.rev, boundary);
          if (head.prepared === undefined && entry.rev === head.rev && entry.sha === head.sha && boundary !== head.through) throw new Error('legacy HEAD through conflicts with durable revision accounting');
        }
      }
    }
    if (head && ((head.prepared !== undefined && !prepared) || (head.prepared === undefined && hasPreparation))) throw new Error('HEAD is missing its independently prepared sequence boundary; refusing recovery');
    // A legacy HEAD with missing accounting has no independent sequence witness.
    // Preserve its historical recovery behavior until a normal new commit occurs.
  }

  recover(): void {
    const head = this.head();
    const cached = this.loadRecoveryCheckpoint();
    if (!cached) this.validateHeadBoundary(head);
    const tornBytes = truncateTornTail(this.l.events);
    const repairedReceipt = cached ? undefined : this.repairRevisionLog(head);
    const removed = removeTemps([this.l.stateDir, this.l.revisions], [dirname(this.l.workingContext)]);

    removed.push(...removeDirectoryEntries(this.l.revisions, name => {
      const m = /^(\d+)\.md$/.exec(name);
      return !!m && Number(m[1]) > (head?.rev ?? 0);
    }));

    // A runner append committed HEAD but died before rewriting the Working Context.
    let rematerialized = false;
    let interruptedReceipt: Receipt | undefined = repairedReceipt;
    if (head && !head.materialized) {
      const read = readWorkingContextFile(this.l.workingContext, Math.min(SNAPSHOT_MAX_BYTES, Math.max(this.hardLimit * 4, statSync(join(this.l.revisions, `${head.rev}.md`)).size)));
      const current = read && typeof read !== 'string' ? decode(read) : null;
      const currentSha = current === null ? null : sha(current);
      if (currentSha !== head.sha) {
        this.materialize(head, this.snapshot(head.rev));
        interruptedReceipt = this.pendingReceipt ?? repairedReceipt;
        rematerialized = true;
      } else {
        head.materialized = true;
        atomicWrite(this.l.head, JSON.stringify(head), 'head-tmp');
      }
    }

    if (repairedReceipt && interruptedReceipt && !interruptedReceipt.text.includes(repairedReceipt.text)) interruptedReceipt = {...interruptedReceipt,text:`${repairedReceipt.text}\n${interruptedReceipt.text}`};
    const log = cached ? [] : readLog(this.l.events);
    if (!cached && this.budgetTokens !== null) this.memory = budgetMemory(readLog(this.l.events), this.budgetTokens);
    const logged: Pending[] = [];
    for (const entry of log) {
      if (entry.type !== 'runner-events') continue;
      const batch = (entry.events as Pending[]).map((p) => ({ seq: p.seq, event: p.event }) as Pending);
      if (entry.replace && batch[0]) batch[0].replace = entry.replace as Replacement;
      for(const p of batch){this.lastSeq=Math.max(this.lastSeq,p.seq);if(p.seq>(head?.through??0))logged.push(p);}
    }
    // Historical committed payloads are not retained; only replay candidates remain.

    const synced = this.sync();
    this.pendingReceipt = interruptedReceipt ?? synced.receipt;
    const replay = logged.filter((e) => e.seq > (this.head()?.through ?? 0));
    this.unapplied = replay;
    if (replay.length) this.apply();

    if (removed.length || tornBytes || rematerialized || replay.length) {
      appendLog(this.l.events, {
        type: 'recovered',
        removed,
        tornLogBytes: tornBytes,
        rematerialized,
        replayed: replay.map((e) => e.seq),
      });
    }
  }
}
