#!/usr/bin/env node
// Test support: a scripted stand-in for `codex app-server --listen stdio://`.
//
// It speaks newline-delimited JSON-RPC 2.0 on stdio like the real server and keeps a minimal model
// of thread history (injected items + each turn's user and assistant messages), so tests can see
// what the model would have been sent. Everything it receives, and every "model request" it
// builds, is appended to $FAKE_CODEX_LOG as JSON lines. $FAKE_CODEX_SCRIPT (a JSON file) scripts
// the turns: replies, Working Context edits made "by the model", tool calls, failures, errors.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

interface TurnScript {
  reply?: string;
  /** Simulates the model editing a file during the turn (e.g. its Working Context). */
  writeFile?: { path: string; content?: string; contentBase64?: string };
  command?: { command: string; output: string; exitCode: number };
  status?: 'completed' | 'failed' | 'interrupted';
  /** Sends a server -> client request (an approval) during the turn and waits for the answer. */
  serverRequest?: boolean;
  hang?: boolean;
  ignoreInterrupt?: boolean;
  /** Never answers turn/start. The turn's notifications still arrive, carrying its turn ID. */
  dropStartReply?: boolean;
  /** An agentMessage for the new turn, sent before the turn/start reply. */
  earlyItem?: string;
  /** Items for a foreign turn on this thread (before and after the reply) and for the previous thread. */
  foreignItems?: boolean;
}

interface Script {
  turns?: TurnScript[];
  /** Methods that fail with this JSON-RPC error. */
  errors?: Record<string, { code: number; message: string }>;
  /** Methods whose first call only fails with this JSON-RPC error. */
  errorsOnce?: Record<string, { code: number; message: string }>;
  /** Exit abruptly when this method arrives. */
  exitOn?: string;
}

type Msg = { id?: string | number; method?: string; params?: any; result?: any; error?: any };

const logPath = process.env.FAKE_CODEX_LOG;
const script: Script = process.env.FAKE_CODEX_SCRIPT ? JSON.parse(readFileSync(process.env.FAKE_CODEX_SCRIPT, 'utf8')) : {};
const log = (entry: unknown) => {
  if (logPath) appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
};
log({ argv: process.argv.slice(2), cwd: process.cwd() });

const send = (m: Msg): void => {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
};
const threads = new Map<string, { history: Array<{ role: string; text: string }>; params: any }>();
const waiting = new Map<string | number, (m: Msg) => void>();
const failedOnce = new Set<string>();
let threadSeq = 0;
let turnSeq = 0;
let itemSeq = 0;
const active = new Map<string, { threadId: string; ignoreInterrupt: boolean }>();

const textOf = (content: unknown): string =>
  Array.isArray(content) ? content.map((p: any) => (typeof p?.text === 'string' ? p.text : JSON.stringify(p))).join('\n') : JSON.stringify(content);

const notifyItem = (threadId: string, turnId: string, item: object) =>
  send({ method: 'item/completed', params: { threadId, turnId, item: { id: `item-${++itemSeq}`, ...item }, completedAtMs: Date.now() } });

async function runTurn(threadId: string, turnId: string, input: any[], s: TurnScript): Promise<void> {
  const thread = threads.get(threadId)!;
  const prompt = { role: 'user', text: textOf(input) };
  log({ modelRequest: { threadId, turnId, input: [...thread.history, prompt] } });
  if (s.writeFile) {
    const data = s.writeFile.contentBase64 !== undefined ? Buffer.from(s.writeFile.contentBase64, 'base64') : (s.writeFile.content ?? '');
    writeFileSync(s.writeFile.path, data);
  }
  if (s.serverRequest) {
    const answer = await new Promise<Msg>((resolve) => {
      waiting.set('srv-1', resolve);
      send({ id: 'srv-1', method: 'item/commandExecution/requestApproval', params: { threadId, turnId } });
    });
    log({ serverRequestAnswer: answer });
  }
  const item = (item: object) => notifyItem(threadId, turnId, item);
  item({ type: 'userMessage', content: input });
  if (s.command) {
    item({ type: 'commandExecution', command: s.command.command, aggregatedOutput: s.command.output, exitCode: s.command.exitCode, status: 'completed' });
  }
  const reply = s.reply ?? `reply ${turnId}`;
  item({ type: 'agentMessage', text: reply });
  send({ method: 'thread/tokenUsage/updated', params: { threadId, turnId, tokenUsage: { total: { inputTokens: 10 }, last: { inputTokens: 10 } } } });
  thread.history.push(prompt, { role: 'assistant', text: reply });
  if (s.foreignItems) {
    notifyItem(`thread-${Number(threadId.slice('thread-'.length)) - 1}`, turnId, { type: 'agentMessage', text: 'FOREIGN_PREVIOUS_THREAD' });
    notifyItem(threadId, 'turn-foreign', { type: 'agentMessage', text: 'FOREIGN_LATE_TURN' });
  }
  const status = s.status ?? 'completed';
  if (s.hang) {
    active.set(turnId, { threadId, ignoreInterrupt: !!s.ignoreInterrupt });
    return;
  }
  send({
    method: 'turn/completed',
    params: { threadId, turn: { id: turnId, items: [], status, error: status === 'failed' ? { message: 'scripted failure' } : null } },
  });
}

function handle(m: Msg): void {
  if (m.method === undefined) {
    // A response to one of our server -> client requests.
    waiting.get(m.id!)?.(m);
    waiting.delete(m.id!);
    return;
  }
  if (script.exitOn === m.method) process.exit(3);
  const once = failedOnce.has(m.method) ? undefined : script.errorsOnce?.[m.method];
  if (once) failedOnce.add(m.method);
  const err = script.errors?.[m.method] ?? once;
  if (err && m.id !== undefined) return send({ id: m.id, error: err });
  const p = m.params ?? {};
  switch (m.method) {
    case 'initialize':
      return send({ id: m.id, result: { userAgent: 'fake-app-server/0', codexHome: '/nonexistent', platformFamily: 'unix', platformOs: 'linux' } });
    case 'initialized':
      return;
    case 'thread/start': {
      const id = `thread-${++threadSeq}`;
      threads.set(id, { history: [], params: p });
      return send({ id: m.id, result: { thread: { id, turns: [] }, model: p.model ?? 'fake-model', modelProvider: 'fake', cwd: p.cwd } });
    }
    case 'thread/inject_items': {
      const thread = threads.get(p.threadId);
      if (!thread) return send({ id: m.id, error: { code: -32600, message: `thread not found: ${p.threadId}` } });
      for (const it of p.items ?? []) thread.history.push({ role: it?.role ?? `(${it?.type})`, text: textOf(it?.content) });
      return send({ id: m.id, result: {} });
    }
    case 'turn/start': {
      if (!threads.has(p.threadId)) return send({ id: m.id, error: { code: -32600, message: `thread not found: ${p.threadId}` } });
      const turnId = `turn-${++turnSeq}`;
      const s = script.turns?.[turnSeq - 1] ?? {};
      if (s.earlyItem !== undefined) notifyItem(p.threadId, turnId, { type: 'agentMessage', text: s.earlyItem });
      if (s.foreignItems) notifyItem(p.threadId, 'turn-foreign', { type: 'agentMessage', text: 'FOREIGN_EARLY_TURN' });
      if (!s.dropStartReply) send({ id: m.id, result: { turn: { id: turnId, items: [], status: 'inProgress', error: null } } });
      void runTurn(p.threadId, turnId, p.input ?? [], s);
      return;
    }
    case 'thread/unsubscribe':
      return send({ id: m.id, result: { status: 'unsubscribed' } });
    case 'turn/interrupt': {
      send({ id: m.id, result: {} });
      const turn = active.get(p.turnId);
      if (turn && !turn.ignoreInterrupt) {
        active.delete(p.turnId);
        send({ method: 'turn/completed', params: { threadId: turn.threadId, turn: { id: p.turnId, status: 'interrupted' } } });
      }
      return;
    }
    default:
      if (m.id !== undefined) send({ id: m.id, error: { code: -32601, message: `method not found: ${m.method}` } });
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  const m = JSON.parse(line) as Msg;
  log({ recv: m });
  handle(m);
});
