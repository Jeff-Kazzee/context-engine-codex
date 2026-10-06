// INTERNAL fault-injection seam, private to the core's own tests. Not exported from index.ts.
//
// The write protocol calls `crashPoint(name)` at every place where a real process could die.
// A test arms one point; the next time execution reaches it, an InjectedCrash is thrown and the
// Session object is abandoned, exactly as if the adapter process had been killed there.

export type CrashPoint =
  | 'log-torn' // half of an Event Log line written
  | 'after-log' // runner events logged, not yet applied
  | 'snapshot-tmp' // revision snapshot temp file written, not renamed
  | 'before-head' // snapshot renamed, HEAD not moved
  | 'head-tmp' // HEAD temp file written, not renamed
  | 'before-wc' // HEAD moved, Working Context not yet rewritten
  | 'wc-tmp' // Working Context temp file written, not renamed
  | 'lock-tmp' // lock temp file written, not renamed
  | 'frame-key-tmp'; // frame-key temp file written, not published

export class InjectedCrash extends Error {}

let armed: CrashPoint | null = null;

export function armCrash(point: CrashPoint | null): void {
  armed = point;
}

export function crashPoint(point: CrashPoint): void {
  if (armed !== point) return;
  armed = null;
  throw new InjectedCrash(`injected crash at ${point}`);
}

// Lock-step seam, private to the core's tests: the lock code calls `lockStep(step, path)` at the
// points where a concurrent contender can interleave, so a test can pause a contender there and
// drive an exact three-process schedule.
export type LockStep =
  | 'stale-seen' // a dead (or unreadable) holder was observed; nothing done about it yet
  | 'stale-removing' // about to remove what is at the lock path
  | 'live-wait'; // a live holder was observed; about to wait for it

let lockHook: ((step: LockStep, path: string) => void) | null = null;

export function setLockStepHook(fn: ((step: LockStep, path: string) => void) | null): void {
  lockHook = fn;
}

export function lockStep(step: LockStep, path: string): void {
  lockHook?.(step, path);
}

// Open-race seam, private to the core's tests: confined reads call `confineStep('before-open', path)`
// after every path-based check and just before opening, so a test can swap the file (or a directory
// above it) for a link at exactly the moment a real attacker would.
export type ConfineStep = 'before-open';

let confineHook: ((step: ConfineStep, path: string) => void) | null = null;

export function setConfineHook(fn: ((step: ConfineStep, path: string) => void) | null): void {
  confineHook = fn;
}

export function confineStep(step: ConfineStep, path: string): void {
  confineHook?.(step, path);
}

// Where confined reads ask the kernel what an open descriptor is. Tests point it at a missing
// directory to prove a system without /proc fails closed.
let procFdDir = '/proc/self/fd';

export function setProcFdDir(dir: string | null): void {
  procFdDir = dir ?? '/proc/self/fd';
}

export function fdLinkPath(fd: number): string {
  return `${procFdDir}/${fd}`;
}
