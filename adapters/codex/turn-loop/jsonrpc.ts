// Newline-delimited JSON-RPC 2.0 over a child process's stdio: the transport of
// `codex app-server --listen stdio://`.
//
// - Responses are matched on id; notifications interleave freely and go to listeners.
// - Server-to-client requests (approvals and the like) are answered with -32601: a headless client
//   has nobody to ask, and an unanswered request would stall the turn.
// - If the process exits, every pending request rejects.
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

export class RpcError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.data = data;
  }
}

export interface Notification {
  method: string;
  params: any;
}

export interface JsonRpcConnection {
  readonly pid: number | undefined;
  /** Resolves when the owned process fails or exits; never rejects unattended. */
  readonly exited: Promise<Error>;
  request<T = unknown>(method: string, params?: unknown, opts?: { timeoutMs?: number }): Promise<T>;
  notify(method: string, params?: unknown): void;
  /** Subscribes to notifications (and refused server requests, as `{method, params}`). Returns an unsubscribe function. */
  onNotification(listener: (n: Notification) => void): () => void;
  /** Ends stdin, waits briefly for exit, then kills. */
  close(): Promise<void>;
}

export interface SpawnOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Where the child's stderr goes: a file descriptor, or 'ignore'. Default: ignored. */
  stderr?: number | 'ignore' | 'inherit';
  /** Default per-request timeout. */
  timeoutMs?: number;
}

const REFUSED = -32601;

export function spawnJsonRpc(command: string[], opts: SpawnOptions): JsonRpcConnection {
  const [bin, ...args] = command;
  if (!bin) throw new Error('empty command');
  const child: ChildProcess = spawn(bin, args, { cwd: opts.cwd, env: opts.env, stdio: ['pipe', 'pipe', opts.stderr ?? 'ignore'] });
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout | undefined }>();
  const listeners = new Set<(n: Notification) => void>();
  let nextId = 0;
  let exitError: Error | undefined;
  let resolveExit!: (error: Error) => void;
  const exited = new Promise<Error>(resolve => { resolveExit = resolve; });

  const write = (msg: object) => {
    if (exitError) return;
    if (!child.stdin?.writable || child.stdin.destroyed || child.stdin.writableEnded) {
      failAll(new Error('app-server input is closed'));
      return;
    }
    try { child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`); }
    catch (e) { failAll(new Error(`app-server input failed: ${e instanceof Error ? e.message : String(e)}`)); }
  };
  const emit = (n: Notification) => {
    for (const l of [...listeners]) l(n);
  };
  const failAll = (e: Error) => {
    exitError ??= e;
    resolveExit(exitError);
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      p.reject(exitError);
      pending.delete(id);
    }
  };

  child.on('error', (e) => failAll(new Error(`app-server could not run: ${e.message}`)));
  child.on('exit', (code, signal) => failAll(new Error(`app-server exited (code ${code}, signal ${signal})`)));
  child.stdin?.on('error', (e) => failAll(new Error(`app-server input failed: ${e.message}`)));
  child.stdin?.on('close', () => failAll(new Error('app-server input is closed')));

  createInterface({ input: child.stdout! }).on('line', (line) => {
    if (!line.trim()) return;
    let m: any;
    try {
      m = JSON.parse(line);
    } catch {
      return; // not protocol output
    }
    if (typeof m !== 'object' || m === null) return;
    if (typeof m.method === 'string' && m.id !== undefined) {
      write({ id: m.id, error: { code: REFUSED, message: 'context-engine turn loop: server requests are not handled' } });
      emit({ method: m.method, params: { ...m.params, refusedRequestId: m.id } });
      return;
    }
    if (typeof m.method === 'string') return emit({ method: m.method, params: m.params });
    const p = typeof m.id === 'number' ? pending.get(m.id) : undefined;
    if (!p) return;
    pending.delete(m.id);
    clearTimeout(p.timer);
    if (m.error) p.reject(new RpcError(m.error.code, m.error.message, m.error.data));
    else p.resolve(m.result);
  });

  return {
    pid: child.pid,
    exited,
    request<T>(method: string, params?: unknown, ro?: { timeoutMs?: number }): Promise<T> {
      if (exitError) return Promise.reject(exitError);
      const id = ++nextId;
      return new Promise<T>((resolve, reject) => {
        const ms = ro?.timeoutMs ?? opts.timeoutMs;
        const timer = ms
          ? setTimeout(() => {
              pending.delete(id);
              reject(new Error(`${method} timed out after ${ms} ms`));
            }, ms)
          : undefined;
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
        write({ id, method, params });
      });
    },
    notify(method: string, params?: unknown) {
      write(params === undefined ? { method } : { method, params });
    },
    onNotification(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise<void>((r) => child.once('exit', () => r()));
      child.stdin?.end();
      const timer = setTimeout(() => child.kill('SIGTERM'), 2000);
      const hard = setTimeout(() => child.kill('SIGKILL'), 5000);
      await exited;
      clearTimeout(timer);
      clearTimeout(hard);
    },
  };
}
