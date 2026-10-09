// Test support: the Codex hook as Codex runs it, a separate process that reads one event as JSON on
// stdin. Every run is bounded. A run that outlives its bound is killed with its whole process group,
// so no hook or core CLI child survives a failed test.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture } from '../../../core/testing.ts';
import { setParticipation } from '../../../core/index.ts';
import { layout } from '../../../core/store.ts';

export const HOOK = fileURLToPath(new URL('../plugin/hooks/codex-hook.ts', import.meta.url));
export const CLI = fileURLToPath(new URL('../../../core/cli.ts', import.meta.url));
/** A stand-in Codex process: runs a list of hook events in order, then exits. */
export const RUNNER = fileURLToPath(new URL('./runner.ts', import.meta.url));

export type Fixture = ReturnType<typeof fixture>;

export interface Run {
  pid: number;
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  ms: number;
  timedOut: boolean;
}

export interface Started {
  pid: number;
  done: Promise<Run>;
}

/** Starts `argv` in its own process group. Past `timeoutMs` the whole group is killed. */
export function startBounded(argv: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; input: string; timeoutMs: number }): Started {
  const started = performance.now();
  const child = spawn(argv[0]!, argv.slice(1), { cwd: opts.cwd, env: opts.env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', timedOut = false;
  child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
  child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
  child.stdin.on('error', () => {});
  child.stdin.end(opts.input);
  const timer = setTimeout(() => { timedOut = true; killGroup(child.pid!); }, opts.timeoutMs);
  const done = new Promise<Run>((resolve, reject) => {
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (status, signal) => {
      clearTimeout(timer);
      resolve({ pid: child.pid!, status, signal, stdout, stderr, ms: performance.now() - started, timedOut });
    });
  });
  return { pid: child.pid!, done };
}

export function killGroup(pgid: number): void {
  try { process.kill(-pgid, 'SIGKILL'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
}

export function enabledFixture(): Fixture {
  const f = fixture();
  setParticipation({ ...f, state: 'on' });
  return f;
}

export function hookEnv(f: Fixture, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...process.env, CONTEXT_ENGINE_CLI: CLI, CONTEXT_ENGINE_STATE_DIR: f.stateDir, CONTEXT_ENGINE: '', NODE_OPTIONS: '', ...extra };
}

/** One hook event as Codex sends it, with the fields every event carries. */
export function event(f: Fixture, sid: string, fields: Record<string, unknown>): Record<string, unknown> {
  return { session_id: sid, cwd: f.projectRoot, transcript_path: null, model: 'gpt-6-luna', ...fields };
}

export function runHook(f: Fixture, sid: string, fields: Record<string, unknown>, extra: Record<string, string> = {}, timeoutMs = 30_000): Promise<Run> {
  return startBounded([process.execPath, HOOK], { cwd: f.projectRoot, env: hookEnv(f, extra), input: JSON.stringify(event(f, sid, fields)), timeoutMs }).done;
}

/** Starts a stand-in Codex process that runs `fields` as hook events, in order, as its children. */
export function startRunner(f: Fixture, sid: string, events: Array<Record<string, unknown>>, extra: Record<string, string> = {}, timeoutMs = 60_000): Started {
  return startBounded([process.execPath, RUNNER], { cwd: f.projectRoot, env: hookEnv(f, extra), input: JSON.stringify(events.map(fields => event(f, sid, fields))), timeoutMs });
}

/** The runner's report: one hook result per event, in order. */
export function runnerResults(run: Run): Array<{ status: number | null; stdout: string; stderr: string }> {
  return run.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

export const prompt = (text: string) => ({ hook_event_name: 'UserPromptSubmit', turn_id: 't1', permission_mode: 'default', prompt: text });
export const toolUse = (tool_name: string, tool_input: unknown, tool_response: unknown, tool_use_id = `call_${Math.random().toString(36).slice(2)}`) =>
  ({ hook_event_name: 'PostToolUse', turn_id: 't1', permission_mode: 'default', tool_name, tool_input, tool_response, tool_use_id });
export const stop = (message: string) => ({ hook_event_name: 'Stop', turn_id: 't1', permission_mode: 'default', stop_hook_active: false, last_assistant_message: message });
export const newContext = { hook_event_name: 'PreToolUse', turn_id: 't1', permission_mode: 'default', tool_name: 'new_context', tool_input: {}, tool_use_id: 'call_nc' };
export const preCompact = { hook_event_name: 'PreCompact', turn_id: 't1', trigger: 'auto' };

const digest = (path: string): string | null => existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null;

/** Digests of the session's durable state: Event Log, HEAD, Working Context and the hook's private markers. */
export function sessionBytes(f: Fixture, sid: string): Record<string, string | null> {
  const l = layout(f.projectRoot, sid, f.stateDir);
  const out: Record<string, string | null> = { events: digest(l.events), head: digest(l.head), context: digest(l.workingContext) };
  if (existsSync(l.stateDir)) for (const name of readdirSync(l.stateDir).sort()) if (/^codex-.*\.json$/.test(name)) out[name] = digest(join(l.stateDir, name));
  return out;
}

/** Every runner event the core logged for the session, with its sequence number. */
export function loggedEvents(f: Fixture, sid: string): Array<{ seq: number; event: { role: string; text: string } }> {
  const l = layout(f.projectRoot, sid, f.stateDir);
  if (!existsSync(l.events)) return [];
  return readFileSync(l.events, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
    .filter(row => row.type === 'runner-events').flatMap(row => row.events);
}

export function headRevision(f: Fixture, sid: string): number {
  const head = layout(f.projectRoot, sid, f.stateDir).head;
  return existsSync(head) ? JSON.parse(readFileSync(head, 'utf8')).rev : 0;
}

export function pendingMarkers(f: Fixture, sid: string): string[] {
  const dir = layout(f.projectRoot, sid, f.stateDir).stateDir;
  return existsSync(dir) ? readdirSync(dir).filter(name => /^codex-(record|prompt)-pending/.test(name)) : [];
}

export function denial(run: Run): string {
  const out = run.stdout === '' ? {} : JSON.parse(run.stdout);
  if (out.hookSpecificOutput?.permissionDecision !== 'deny') throw new Error(`expected a deny, got ${run.stdout || '(empty stdout)'}`);
  return out.hookSpecificOutput.permissionDecisionReason as string;
}

export const stoppedContinuation = (run: Run): boolean => run.stdout !== '' && JSON.parse(run.stdout).continue === false;
