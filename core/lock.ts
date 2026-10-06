// Single-writer session lock. The holder is identified by pid + hostname + process start marker
// (Linux: start time from /proc/<pid>/stat, so a recycled pid is not mistaken for the holder).
import { randomBytes } from 'node:crypto';
import { closeSync, linkSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';
import { lockStep } from './faults.ts';
import { atomicWrite, readBytes, openPrivateDirectory } from './store.ts';
import { dirname, basename, join } from 'node:path';

export interface LockHolder {
  pid: number;
  hostname: string;
  /** Process start marker, or null where the platform doesn't expose one. */
  startMarker: string | null;
  runner: string;
  hardLimit: number;
  acquiredAt: string;
}

export function processStartMarker(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // Field 2 (comm) may contain spaces and parens; fields after the last ')' start at field 3.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return fields[19] ?? null; // field 22: starttime
  } catch {
    return null;
  }
}

export function holderFor(pid: number, runner: string, hardLimit: number): LockHolder {
  return { pid, hostname: hostname(), startMarker: processStartMarker(pid), runner, hardLimit, acquiredAt: new Date().toISOString() };
}

const sameProcess = (a: LockHolder, b: LockHolder) => a.pid === b.pid && a.hostname === b.hostname && a.startMarker === b.startMarker;

/** True unless the holder is known to be dead. A holder on another host is assumed alive. */
export function isAlive(h: LockHolder): boolean {
  if (h.hostname !== hostname()) return true;
  try {
    process.kill(h.pid, 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ESRCH') return false;
  }
  const marker = processStartMarker(h.pid);
  return !(h.startMarker && marker && marker !== h.startMarker);
}

export function readLock(path: string): LockHolder | null | 'unreadable' {
  let bytes: Buffer | undefined;
  const deadline=Date.now()+100;
  for(;;){try{bytes=readBytes(path,16384);break;}catch(e){
    // A legitimate link publication briefly has two names. Wait without reading;
    // Lock release/replacement can also invalidate an opened descriptor before verification.
    // Never read it; persistent unsafe names throw and cannot become dead-lock takeovers.
    if(!['CE_STATE_LINK_COUNT','CE_STATE_PATH_CHANGED'].includes((e as NodeJS.ErrnoException).code??'') || Date.now()>=deadline)throw e;
    sleepSync(1);
  }}
  if(bytes===undefined)return null;
  try {
    const h = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)) as LockHolder;
    if(!h || !Number.isSafeInteger(h.pid) || h.pid<=0 || typeof h.hostname!=='string' || !(h.startMarker===null || typeof h.startMarker==='string') || typeof h.runner!=='string' || typeof h.hardLimit!=='number' || !Number.isFinite(h.hardLimit) || h.hardLimit<0 || typeof h.acquiredAt!=='string')return 'unreadable';
    return {pid:h.pid,hostname:h.hostname,startMarker:h.startMarker,runner:h.runner,hardLimit:h.hardLimit,acquiredAt:h.acquiredAt};
  } catch {
    return 'unreadable';
  }
}

export type Acquired =
  | { status: 'acquired'; takeoverFrom: LockHolder | 'unreadable' | null; reused?: boolean }
  | { status: 'refused'; holder: LockHolder };

/**
 * Takes the lock for `me`. Re-entrant for the same process; takes over from a dead holder.
 *
 * A lock is only ever created by hard-linking a fully written record into place (link() fails
 * atomically if a lock exists), and only ever removed by its live owner (release) or by
 * `removeIfDead`, which re-checks the holder while holding the break lock. So a contender that saw
 * a dead holder can never remove a live lock that replaced it, and two contenders cannot both take
 * the same dead lock over.
 */
export function acquireLock(path: string, me: LockHolder): Acquired {
  let deadSeen: LockHolder | 'unreadable' | null = null;
  const deadline = Date.now() + 5_000;
  for (;;) {
    if (tryLink(path, me)) return { status: 'acquired', takeoverFrom: deadSeen };
    const current = readLock(path);
    if (current === null) continue; // released between our link and our read: try again
    if (current !== 'unreadable') {
      if (sameProcess(current, me)) {
        atomicWrite(path, JSON.stringify({ ...me, acquiredAt: current.acquiredAt }), 'lock-tmp');
        return { status: 'acquired', takeoverFrom: null, reused: true };
      }
      if (isAlive(current)) return { status: 'refused', holder: current };
    }
    lockStep('stale-seen', path);
    deadSeen = current;
    if (removeIfDead(path) === 'busy') {
      // Another contender is mid-takeover; that takes microseconds unless it is wedged.
      if (Date.now() > deadline) return { status: 'refused', holder: current === 'unreadable' ? me : current };
      sleepSync(1);
    }
  }
}

export function releaseLock(path: string, me: LockHolder): void {
  const current = readLock(path);
  if (current && current !== 'unreadable' && sameProcess(current, me)) unlinkSync(path);
}

/** Thrown by `serialized` when the operation lock stays held by a live process past the timeout. */
export class SerializeTimeout extends Error {}

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Same-owner serialization. The session lock admits every call that presents the same owner pid,
 * and a runner can make several such calls at once (Codex runs the PostToolUse hooks of parallel
 * tool calls concurrently, each through its own CLI process). This runs `fn` while holding a
 * second, short-lived lock at `path`, held by the calling process itself, so those calls run one
 * at a time. The lock is taken the same way as the session lock (write, then hard-link into
 * place), and a holder that died is taken over through `removeIfDead`. A live holder is waited
 * for, up to `timeoutMs`; after that SerializeTimeout is thrown and nothing is done.
 */
export function serialized<T>(path: string, fn: () => T, opts: { timeoutMs?: number } = {}): T {
  const me = holderFor(process.pid, 'serialize', 0);
  const deadline = Date.now() + (opts.timeoutMs ?? 15_000);
  for (;;) {
    if (tryLink(path, me)) break;
    const current = readLock(path);
    if (current === null) continue; // released between our link and our read: try again
    if (current === 'unreadable' || !isAlive(current)) {
      lockStep('stale-seen', path);
      if (removeIfDead(path) !== 'busy') continue;
    } else lockStep('live-wait', path);
    if (Date.now() > deadline) throw new SerializeTimeout(`session busy: another call has held ${path} for too long`);
    sleepSync(5);
  }
  try {
    return fn();
  } finally {
    releaseLock(path, me);
  }
}

function tryLink(path: string, me: LockHolder): boolean {
  const parent=openPrivateDirectory(dirname(path))!;
  const target=join(`/proc/self/fd/${parent}`,basename(path));
  const candidate = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.new`;
  try {
  const fd = openSync(candidate, 'wx', 0o600);
  try {
    const bytes = Buffer.from(JSON.stringify(me));
    try {
      for (let offset = 0; offset < bytes.length;) {
        const written = writeSync(fd, bytes, offset, bytes.length - offset);
        if (written <= 0) throw new Error('lock record write made no progress; lock not published');
        offset += written;
      }
    } finally { closeSync(fd); }
    linkSync(candidate, target);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    return false;
  } finally {
    unlinkSync(candidate);
  }
  } finally {closeSync(parent);}
}

/**
 * Removes the lock at `path` only if its holder is dead (or its record unreadable), checked while
 * holding the break lock `<path>.break`, itself taken by hard link. Every removal of a lock other
 * than one's own goes through here, and nothing can be linked over an existing lock, so between
 * that check and the unlink the lock cannot change: a live lock is never removed. A break lock
 * left by a breaker that died mid-break is removed the same way, one level up.
 *
 * Returns 'done' when the lock is gone or was found live (the caller re-checks), 'busy' when
 * another contender holds the break lock.
 */
function removeIfDead(path: string): 'done' | 'busy' {
  const breakPath = `${path}.break`;
  const me = holderFor(process.pid, 'lock-break', 0);
  if (!tryLink(breakPath, me)) {
    const breaker = readLock(breakPath);
    if (breaker !== null && (breaker === 'unreadable' || !isAlive(breaker))) removeIfDead(breakPath);
    return 'busy';
  }
  try {
    const current = readLock(path);
    if (current === null || (current !== 'unreadable' && isAlive(current))) return 'done';
    lockStep('stale-removing', path);
    try {
      unlinkSync(path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    return 'done';
  } finally {
    releaseLock(breakPath, me);
  }
}
