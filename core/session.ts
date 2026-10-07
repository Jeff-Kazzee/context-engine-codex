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
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { crashPoint } from './faults.ts';
import { acquireLock, holderFor, isAlive, readLock, releaseLock, serialized, type LockHolder } from './lock.ts';
import {
  appendLog,
  atomicWrite,
  ensureDirs,
  layout,
  readBytes,
  readLog,
  readWorkingContextFile,
  assertWorkingContextDir,
  removeTemps,
  removeDirectoryEntries,
  resolveStateRoot,
  sessionFrameKey,
  sha,
  truncateTornTail,
  type Layout,
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
  /** Releases the lock. The session can be reopened later from its latest revision. */
  close(): void;
}

export type OpenResult = { status: 'open'; session: Session } | { status: 'refused'; holder: LockHolder };

interface Head {
  rev: number;
  sha: string;
  parent: string | null;
  through: number;
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
  const stateRoot = resolveStateRoot(opts.stateDir);
  const l = layout(opts.projectRoot, opts.sessionId, stateRoot);
  ensureDirs(l, stateRoot);
  const me = holderFor(opts.ownerPid ?? process.pid, opts.runner, opts.hardLimit);
  const got = acquireLock(l.lock, me);
  if (got.status === 'refused') return { status: 'refused', holder: got.holder };
  try {
    // Cut a torn Event Log tail before anything else is appended to it.
    const tornBytes = truncateTornTail(l.events);
    const core = new Core(l, opts.hardLimit, me, experimentOn('stale-refs', opts.experiments) ? opts.projectRoot : null, opts.budgetTokens ?? null);
    core.recover(tornBytes);
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

function decodeHead(raw: Buffer | undefined): Head | null {
  if(!raw)return null;
  const head=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw)) as Head;
  if(!head || Array.isArray(head) || !Number.isSafeInteger(head.rev) || head.rev<1 || typeof head.sha!=='string' || !/^[a-f0-9]{64}$/.test(head.sha) || !Number.isSafeInteger(head.through) || head.through<0 || typeof head.materialized!=='boolean' || !(head.parent===null || typeof head.parent==='string'&&/^[a-f0-9]{64}$/.test(head.parent)) || !(head.kind===undefined || ['init','model-edit','runner-append','native-compaction'].includes(head.kind)))throw new Error('invalid private-state HEAD');
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
      confirmReceiptReturn: () => { if(this.closed)throw new Error('session is closed'); this.confirmReturnedReceipts(); this.saveRecoveryCheckpoint(); },
      record: (events, options) => this.guard(() => this.finishResult(this.record(events, false, options?.maxBytes, options?.operationId))),
      nativeCompaction: (events) => this.guard(() => this.finishResult(this.record(events, true))),
      close: () => this.close(),
    };
  }

  private guard<T>(fn: () => T, repair = true): T {
    if (this.closed) throw new Error('session is closed');
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
      if (c.version !== 2 || !log || JSON.stringify(c.log) !== JSON.stringify(log) || c.head !== sha(readHead(this.l.head)?.toString('utf8') ?? '') || c.budget !== this.budgetTokens || !nonnegative(c.lastSeq) || c.lastSeq !== (head?.through ?? 0) || !m || ![0,25,50,75].includes(m.announced) || !Array.isArray(m.growth) || m.growth.length > 3 || !m.growth.every(nonnegative) || !nonnegative(m.lastTokens) || !(m.loggedBudget === null || (nonnegative(m.loggedBudget) && m.loggedBudget > 0))) return false;
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
      const payload = { version: 2, log, head: sha(readHead(this.l.head)?.toString('utf8') ?? ''), budget: this.budgetTokens, lastSeq: this.lastSeq, memory: this.memory };
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
    const r: SyncResult = { revision: head?.rev ?? 0, turns: parseTurns(text), chars: text.length, workingContextText: text };
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
    this.unloggedCommit = { head, text };
    atomicWrite(this.l.head, JSON.stringify(head), 'head-tmp');
    appendLog(this.l.events, { type: 'revision', rev, kind, sha: head.sha, chars: text.length });
    this.unloggedCommit = undefined;
    if (this.budgetTokens !== null) remember(this.memory, kind, text.length, this.budgetTokens);
    if (materialize) this.materialize(head, text);
    return head;
  }

  private materialize(head: Head, text: string): void {
    crashPoint('before-wc');
    this.writeWorkingContext(text);
    head.materialized = true;
    atomicWrite(this.l.head, JSON.stringify(head), 'head-tmp');
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
      for (const entry of readLog(this.l.events)) {
        if (entry.type !== 'runner-events' || !entry.operation || typeof entry.operation !== 'object') continue;
        const recorded = entry.operation as { id?: unknown; sha?: unknown };
        if (recorded.id !== operation.id) continue;
        if (recorded.sha !== operation.sha) throw new Error('record operation identifier was used for different input');
        return this.result(this.apply(), synced.receipt);
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
    try {appendLog(this.l.events, { type: 'runner-events', events: numbered, ...(operation ? { operation } : {}), ...(replacement ? { replace: replacement } : {}) });}
    catch(e) {if((e as NodeJS.ErrnoException).code==='CE_LOG_APPEND_AMBIGUOUS')this.appendUncertain=true;throw e;}
    this.lastSeq += numbered.length;
    if (replacement) numbered[0]!.replace = replacement;
    this.unapplied.push(...numbered);
    crashPoint('after-log');
    const head = this.apply();
    const r = this.result(head);
    if (synced.receipt) r.receipt = synced.receipt;
    return r;
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
    if (this.closed) throw new Error('session is closed');
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
      const entry = {rev:head.rev,kind:head.kind,sha:head.sha,chars:text.length};
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

  recover(tornBytes: number): void {
    const head = this.head();
    const cached = this.loadRecoveryCheckpoint();
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
        const committed = this.snapshot(head.rev);
        if (current !== null && current.trim() && currentSha !== head.parent) {
          appendLog(this.l.events, { type: 'restored', rev: head.rev, reason: 'unmaterialized-append', rejected: current });
          interruptedReceipt = { kind: 'restored', revision: head.rev, reason: 'unmaterialized-append', chars: committed.length, approxTokens: approxTokens(committed.length), text: `Context Engine: revision ${head.rev} was restored because committed runner events had not yet reached the Working Context. The intervening edit is kept in the Event Log; read the restored file before editing it again. ${sizeReadout(committed.length)}` };
        }
        this.materialize(head, committed);
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
