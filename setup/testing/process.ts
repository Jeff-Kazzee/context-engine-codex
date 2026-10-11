// Test helpers for setup commands a test interrupts. The CLI starts in its own process group, so
// one SIGKILL to the group also stops the fake runner it is waiting on, as a real kill would.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { CLI } from './world.ts';

export interface Finished { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }

/** Starts `context-engine <args>` as a process group leader. */
export function startSetup(args: string[], opts: { cwd: string; env: Record<string, string> }): { pid: number; done: Promise<Finished> } {
  const child = spawn(process.execPath, [CLI, ...args], { cwd: opts.cwd, env: { ...process.env, ...opts.env }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', (s: string) => { stdout += s; });
  child.stderr.setEncoding('utf8').on('data', (s: string) => { stderr += s; });
  const done = new Promise<Finished>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { pid: child.pid!, done };
}

export async function waitForFile(path: string, timeoutMs = 20_000): Promise<void> {
  for (const until = Date.now() + timeoutMs; !existsSync(path);) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${path}`);
    await delay(20);
  }
}

/** SIGKILL every process in the group. A group that already exited is not an error. */
export function killGroup(pid: number): void {
  try { process.kill(-pid, 'SIGKILL'); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; }
}

export function groupAlive(pid: number): boolean {
  try { process.kill(-pid, 0); return true; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ESRCH') return false; throw e; }
}
