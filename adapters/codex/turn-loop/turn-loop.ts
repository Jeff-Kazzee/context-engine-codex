// Codex app-server turn loop: Full Replacement per user turn, for headless and eval runs.
//
// The turn loop owns one `codex app-server --listen stdio://` child (never the user's shared daemon
// socket) and one core session (the turn-loop process holds the session lock). For every user turn:
//
//   core sync -> validate the committed Working Context -> thread/start (fresh, ephemeral)
//   -> thread/inject_items (exactly one validated user message) -> turn/start -> turn/completed
//   -> core record (prompt, one line per tool call, replies)
//
// so each turn's first model request carries the runner's initial context, the Working Context as
// one user message, and the new prompt, and nothing from earlier turns.
//
// Why a fresh thread per turn rather than `thread/revert` on one thread (measured on codex-cli
// 0.160.0 against a mock Responses server, no model use): after the first revert the first turn no
// longer exists, so a second `thread/revert {beforeTurnId: <first turn>}` fails with
// `-32600 turn not found`. Reverting to the latest turn instead keeps the previous injected
// Working Context (it sits before that turn's start), so injections pile up: that is Injection, not
// Full Replacement. A fresh thread has exactly the initial context, so inject + turn/start gives the
// required shape every turn. Cost: each turn gets a new prompt-cache key (the thread id).
//
// Fail closed: if the committed Working Context can't be delivered (it fails validation, or the
// app-server refuses the fresh thread or the injection), the turn is refused with a receipt: no
// model call, and no append-only continuation of an earlier thread. A refused turn reports no
// Delivery Mode (`mode: null`), so nothing claims Full Replacement for a turn that was not replaced.
//
// Mixed mode: this process's app-server runs with `features.token_budget=false` and the Context
// Engine Codex plugin disabled (`plugins.context-engine@context-engine.enabled=false`), so the
// plugin path (its hooks and the new_context reset) can never act on a thread this loop manages.
// These overrides come after any caller overrides, so they win.
//
// developerInstructions: each fresh thread gets `guidance(path)`, static text written here (the
// mode, the file's path, how it is delivered). It never carries model-authored text; the Working
// Context itself only ever travels as the one injected user message.
import { closeSync, openSync, readFileSync } from 'node:fs';
import { KILL_SWITCH_ENV, killSwitchOn, openSession, type Receipt, type RunnerEvent, type Session } from '../../../core/index.ts';
import { workingContextItems, type WorkingContextRejectReason } from './items.ts';
import { spawnJsonRpc, type JsonRpcConnection, type Notification } from './jsonrpc.ts';

export const MODE = 'Full Replacement per user turn';
export type Mode = typeof MODE;

/**
 * Config overrides this loop's own app-server always runs with, after any caller overrides: the
 * plugin path (token_budget's new_context reset, the plugin's hooks) must not act on its threads.
 */
export const OWN_OVERRIDES = ['features.token_budget=false', 'plugins.context-engine@context-engine.enabled=false'] as const;

export interface TurnLoopOptions {
  /** Project (workspace) root: the app-server's cwd and the Working Context's home. */
  projectRoot: string;
  /** Core session id. Reuse it in a new process to resume. */
  sessionId: string;
  model?: string;
  /** Reasoning effort per turn, e.g. 'low'. */
  effort?: string;
  /** Hard limit for the Working Context, in characters. Default 400000 (about 100k tokens). */
  hardLimit?: number;
  approvalPolicy?: string;
  sandbox?: string;
  /** Per-process config overrides, each `key=value`, passed to the app-server as `-c key=value`. */
  configOverrides?: string[];
  /** The Codex executable (and any leading args). Default ['codex']. */
  command?: string[];
  env?: NodeJS.ProcessEnv;
  /** Core state root override (see core OpenOptions.stateDir). */
  stateDir?: string;
  /** File that receives the app-server's stderr. Default: discarded. */
  stderrPath?: string;
  /** Per-turn timeout. Default 30 minutes. */
  turnTimeoutMs?: number;
}

/** A notice for the model: the core's receipts, plus the turn loop's own when it refuses to replace. */
export type TurnLoopReceipt =
  | Receipt
  | { kind: 'not-replaced'; revision: number; reason: WorkingContextRejectReason | 'delivery-failed'; text: string };

export interface TurnResult {
  /** The Delivery Mode this turn got: MODE when it ran on a fresh thread, null when it was refused. */
  mode: Mode | null;
  /** 1-based user turn number within this turn-loop process. */
  turn: number;
  status: 'completed' | 'failed' | 'interrupted' | 'refused';
  /** True when the turn started from a fresh thread holding the injected Working Context. */
  replaced: boolean;
  /** Core revision delivered as the Working Context, or null when none was injected. */
  revisionInjected: number | null;
  /** Core revision after this turn's events were recorded. */
  revisionAfter: number;
  /** Receipts delivered to the model at the start of this turn. */
  receipts: TurnLoopReceipt[];
  threadId: string | null;
  turnId: string | null;
  finalMessage: string;
  /** Completed thread items of the turn, as the app-server sent them. */
  items: unknown[];
  /** Last `thread/tokenUsage/updated` payload of the turn, if any. */
  usage: unknown;
  error: unknown;
}

export interface CodexTurnLoop {
  readonly mode: Mode;
  readonly sessionId: string;
  readonly workingContextPath: string;
  runTurn(prompt: string): Promise<TurnResult>;
  close(): Promise<void>;
}

const DEFAULT_HARD_LIMIT = 400_000;
const VERSION = '0.1.0';

export function guidance(path: string): string {
  return [
    `Context Engine is active (${MODE}).`,
    `Before every user turn your conversation history is replaced by your Working Context: the file ${path},`,
    'delivered to you as one user message (the working_context block). Anything not in that file is gone from your view next turn.',
    'Edit it with ordinary tools to keep what you need (task, decisions, findings, open questions) and delete what you no longer need.',
    'After each turn the runner appends the prompt, one line per tool call and your replies as [[CTX_TURN n role=...]] blocks.',
  ].join('\n');
}

export async function startTurnLoop(opts: TurnLoopOptions): Promise<CodexTurnLoop> {
  // The kill switch stops the turn loop too. It needs no `context-engine enable`: running it is the opt-in.
  const env = opts.env ?? process.env;
  if (killSwitchOn(env)) throw new Error(`Context Engine is turned off (${KILL_SWITCH_ENV}=${env[KILL_SWITCH_ENV]}); the turn loop did not start`);
  const hardLimit = opts.hardLimit ?? DEFAULT_HARD_LIMIT;
  const opened = openSession({ projectRoot: opts.projectRoot, sessionId: opts.sessionId, runner: 'codex', hardLimit, stateDir: opts.stateDir });
  if (opened.status === 'refused') {
    throw new Error(`session ${opts.sessionId} is held by pid ${opened.holder.pid} on ${opened.holder.hostname}`);
  }
  const session = opened.session;
  const stderrFd = opts.stderrPath ? openSync(opts.stderrPath, 'a') : undefined;
  let rpc: JsonRpcConnection | undefined;
  try {
    const args = ['app-server', '--listen', 'stdio://', ...[...(opts.configOverrides ?? []), ...OWN_OVERRIDES].flatMap((c) => ['-c', c])];
    rpc = spawnJsonRpc([...(opts.command ?? ['codex']), ...args], {
      cwd: opts.projectRoot,
      env: opts.env ?? process.env,
      stderr: stderrFd ?? 'ignore',
      timeoutMs: 120_000,
    });
    await rpc.request('initialize', { clientInfo: { name: 'context-engine-codex-turns', version: VERSION }, capabilities: { experimentalApi: false } });
    rpc.notify('initialized');
  } catch (e) {
    await rpc?.close();
    session.close();
    throw e;
  } finally {
    if (stderrFd !== undefined) closeSync(stderrFd);
  }
  return new TurnLoop(opts, hardLimit, session, rpc).facade();
}

class TurnLoop {
  private threadId: string | null = null;
  private turns = 0;
  private pendingReceipts: TurnLoopReceipt[] = [];
  private closed = false;
  private unavailable = false;
  private busy = false;
  private active: Promise<TurnResult> | undefined;
  private closing: Promise<void> | undefined;
  private readonly opts: TurnLoopOptions;
  private readonly hardLimit: number;
  private readonly session: Session;
  private readonly rpc: JsonRpcConnection;

  constructor(opts: TurnLoopOptions, hardLimit: number, session: Session, rpc: JsonRpcConnection) {
    this.opts = opts;
    this.hardLimit = hardLimit;
    this.session = session;
    this.rpc = rpc;
  }

  facade(): CodexTurnLoop {
    return {
      mode: MODE,
      sessionId: this.opts.sessionId,
      workingContextPath: this.session.workingContextPath,
      runTurn: (prompt) => this.runTurn(prompt),
      close: () => this.close(),
    };
  }

  private async newThread(): Promise<string> {
    const r = await this.rpc.request<{ thread: { id: string } }>('thread/start', {
      cwd: this.opts.projectRoot,
      model: this.opts.model,
      approvalPolicy: this.opts.approvalPolicy ?? 'never',
      sandbox: this.opts.sandbox ?? 'workspace-write',
      ephemeral: true,
      developerInstructions: guidance(this.session.workingContextPath),
    });
    return r.thread.id;
  }

  async runTurn(prompt: string): Promise<TurnResult> {
    if (this.closed) throw new Error('turn loop is closed');
    if (this.unavailable) throw new Error('turn loop is unavailable after an uncertain server failure; start a new loop');
    if (this.busy) throw new Error('a turn is already running');
    this.busy = true;
    this.active = this.runOneTurn(prompt);
    try { return await this.active; }
    finally { this.busy = false; this.active = undefined; }
  }

  private async runOneTurn(prompt: string): Promise<TurnResult> {
    const turn = ++this.turns;
    const synced = this.session.sync();
    const receipts = [...this.pendingReceipts, ...(synced.receipt ? [synced.receipt] : [])];
    this.pendingReceipts = [];

    let replaced = false;
    let revisionInjected: number | null = null;
    let threadId: string;
    const notDelivered = (reason: WorkingContextRejectReason | 'delivery-failed', detail: string): TurnResult => {
      receipts.push({
        kind: 'not-replaced',
        revision: synced.revision,
        reason,
        text: `Context Engine: your Working Context (revision ${synced.revision}) was not delivered because ${detail}. This turn was not run (no model call); fix the file and run the turn again.`,
      });
      return this.refused(turn, synced.revision, receipts);
    };
    if (synced.revision === 0) {
      // Nothing committed yet: a fresh thread with no history is the whole context.
      try {
        threadId = await this.newThread();
      } catch (e) {
        return notDelivered('delivery-failed', `the app-server did not start a fresh thread (${errorText(e)})`);
      }
    } else {
      const text = readFileSync(this.session.workingContextPath, 'utf8');
      const built = workingContextItems(text, { path: this.session.workingContextPath, hardLimit: this.hardLimit });
      // Fail closed: never run a turn whose Working Context can't be delivered.
      if (!built.ok) return notDelivered(built.reason, built.detail);
      try {
        threadId = await this.newThread();
        await this.rpc.request('thread/inject_items', { threadId, items: built.items });
      } catch (e) {
        return notDelivered('delivery-failed', `the app-server refused it (${errorText(e)})`);
      }
      replaced = true;
      revisionInjected = synced.revision;
    }
    if (this.threadId) await this.rpc.request('thread/unsubscribe', { threadId: this.threadId }).catch(() => {});
    this.threadId = threadId;

    const input = [...receipts.map((r) => ({ type: 'text', text: r.text })), { type: 'text', text: prompt }];
    const { turnId, status, items, usage, error } = await this.startAndWait(threadId, input);
    const finalMessage = agentMessages(items).at(-1) ?? '';
    const recorded = this.session.record([{ role: 'user', text: prompt }, ...items.flatMap(toEvents)]);
    if (recorded.receipt) this.pendingReceipts.push(recorded.receipt);
    return {
      mode: MODE,
      turn,
      status,
      replaced,
      revisionInjected,
      revisionAfter: recorded.revision,
      receipts,
      threadId,
      turnId,
      finalMessage,
      items,
      usage,
      error,
    };
  }

  private refused(turn: number, revision: number, receipts: TurnLoopReceipt[]): TurnResult {
    // The core's receipts are kept for the next turn, so the model still gets them once a turn runs.
    this.pendingReceipts = receipts.filter((r) => r.kind !== 'not-replaced');
    return {
      mode: null,
      turn,
      status: 'refused',
      replaced: false,
      revisionInjected: null,
      revisionAfter: revision,
      receipts,
      threadId: null,
      turnId: null,
      finalMessage: '',
      items: [],
      usage: null,
      error: receipts.at(-1)!.text,
    };
  }

  private async startAndWait(threadId: string, input: object[]) {
    const items: any[] = [];
    let usage: unknown = null;
    let turnId: string | null = null;
    const early: Notification[] = [];
    let finish: (n: Notification) => void = () => {};
    const completed = new Promise<Notification>((resolve) => (finish = resolve));
    const onNote = (n: Notification) => {
      if (n.params?.threadId !== threadId) return;
      if (turnId === null) return void early.push(n);
      if (n.params.turnId !== undefined && n.params.turnId !== turnId) return;
      if (n.method === 'item/completed') items.push(n.params.item);
      else if (n.method === 'thread/tokenUsage/updated') usage = n.params.tokenUsage;
      else if (n.method === 'turn/completed' && n.params.turn?.id === turnId) finish(n);
    };
    const unsubscribe = this.rpc.onNotification(onNote);
    try {
      const started = await this.rpc.request<{ turn: { id: string } }>('turn/start', { threadId, input, ...(this.opts.effort ? { effort: this.opts.effort } : {}) }, { timeoutMs: this.opts.turnTimeoutMs ?? 30 * 60_000 });
      turnId = started.turn.id;
      for (const n of early.splice(0)) onNote(n);
      const ms = this.opts.turnTimeoutMs ?? 30 * 60_000;
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`turn ${turnId} did not complete within ${ms} ms`)), ms);
      });
      const done = await Promise.race([completed, timeout, this.rpc.exited.then(error => { throw error; })]).finally(() => clearTimeout(timer));
      const t = done.params.turn;
      return { turnId, status: t.status as TurnResult['status'], items, usage, error: t.error ?? null };
    } catch (e) {
      // A start response may be lost after the server began work. Recover any known id and
      // partial notifications, but never assume a request rejection means no turn exists.
      if (turnId === null) {
        turnId = early.map(n => n.params?.turnId ?? n.params?.turn?.id).find(id => typeof id === 'string') ?? null;
        if (turnId !== null) for (const n of early.splice(0)) onNote(n);
      }
      if (turnId !== null) {
        try {
          await this.rpc.request('turn/interrupt', { threadId, turnId }, { timeoutMs: 1000 });
          let timer: NodeJS.Timeout | undefined;
          const done = await Promise.race([completed, new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('interrupted turn did not settle')), 1000);
          })]).finally(() => clearTimeout(timer));
          return { turnId, status: done.params.turn.status as TurnResult['status'], items, usage, error: errorText(e) };
        } catch { /* Uncertain activity: stop the owned process before recording or reusing state. */ }
      }
      this.unavailable = true;
      await this.rpc.close();
      return { turnId, status: 'failed' as const, items, usage, error: errorText(e) };
    } finally {
      unsubscribe();
    }
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    const active = this.active;
    this.closing = (async () => {
      try {
        await this.rpc.close();
        // Recording belongs to the in-flight turn; keep its lock until it settles.
        await active?.then(() => {}, () => {});
      } finally { this.session.close(); }
    })();
    return this.closing;
  }
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const agentMessages = (items: any[]): string[] => items.filter((i) => i?.type === 'agentMessage').map((i) => String(i.text ?? ''));

/** Renders one completed thread item as runner events. Tool output stays in the Event Log only. */
function toEvents(item: any): RunnerEvent[] {
  switch (item?.type) {
    case 'agentMessage':
      return item.text ? [{ role: 'assistant', text: String(item.text) }] : [];
    case 'userMessage':
    case 'reasoning':
    case 'plan':
    case 'hookPrompt':
      return [];
    case 'commandExecution':
      return [{ role: 'tool', text: `$ ${item.command} (exit ${item.exitCode ?? '?'})`, item }];
    case 'fileChange': {
      const paths = Array.isArray(item.changes) ? item.changes.map((c: any) => c?.path).filter(Boolean) : [];
      return [{ role: 'tool', text: `file change: ${paths.join(', ') || '(none)'} (${item.status ?? '?'})`, item }];
    }
    default:
      return [{ role: 'tool', text: `${item?.type ?? 'item'}${item?.tool ? `: ${item.tool}` : ''}`, item }];
  }
}
