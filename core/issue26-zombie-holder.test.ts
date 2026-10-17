// Issue 26: a lock holder that was killed but not yet reaped (a zombie) is dead. Every holder here is
// a real process. Its parent shell is stopped, so the parent cannot reap it, the way an init process
// that does not reap orphans cannot. The kernel state is the same: kill(pid, 0) succeeds and
// /proc/<pid>/stat keeps the holder's start time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { CLI, fixture, tempDir } from './testing.ts';
import { layout } from './store.ts';
import { acquireLock, holderFor, isAlive, processStartMarker, readLock, serialized, SerializeTimeout, type LockHolder } from './lock.ts';

const LOCK = fileURLToPath(new URL('./lock.ts', import.meta.url));

// Takes the lock at argv[1] by `acquireLock` or `serialized` (argv[2]), writes its PID to argv[3],
// then holds the lock until it is killed.
const HOLDER = `
import { writeFileSync } from 'node:fs';
const [lockPath, mode, ready] = process.argv.slice(1);
const { acquireLock, holderFor, serialized } = await import(${JSON.stringify(LOCK)});
const hold = () => { writeFileSync(ready, String(process.pid)); for (;;) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000); };
if (mode === 'serialized') serialized(lockPath, hold);
else if (acquireLock(lockPath, holderFor(process.pid, 'test', 1000)).status === 'acquired') hold();
else process.exit(3);
`;

/** State letter and thread count from /proc/<pid>/stat, read here independently of the code under test. */
function procStat(pid: number): { state: string; threads: number } | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { state: fields[0]!, threads: Number(fields[17]) };
  } catch { return null; }
}
const procState = (pid: number): string | null => procStat(pid)?.state ?? null;

async function until(check: () => boolean, what: string, ms = 15_000): Promise<void> {
  for (const end = Date.now() + ms; !check();) { assert.ok(Date.now() < end, what); await delay(10); }
}

interface Holding { pid: number; parent: ChildProcess; holder: LockHolder }

/** Starts a real holder of `lockPath` as the child of a shell that forks it and does not exec. */
async function startHolder(lockPath: string, mode: 'acquire' | 'serialized'): Promise<Holding> {
  const ready = join(tempDir('holder'), 'ready');
  const parent = spawn('sh', ['-c', '"$0" --input-type=module -e "$1" "$2" "$3" "$4"; :', process.execPath, HOLDER, lockPath, mode, ready], { detached: true, stdio: ['ignore', 'ignore', 'inherit'] });
  try {
    await until(() => existsSync(ready) && readFileSync(ready, 'utf8') !== '', 'the holder took the lock');
    const pid = Number(readFileSync(ready, 'utf8'));
    const holder = readLock(lockPath);
    assert.ok(holder && holder !== 'unreadable' && holder.pid === pid, 'the lock names the holder');
    return { pid, parent, holder };
  } catch (error) { await reap(parent); throw error; }
}

/** Stops the holder's parent so it cannot reap, then kills the holder: a real zombie. */
async function makeZombie(h: Holding): Promise<void> {
  process.kill(h.parent.pid!, 'SIGSTOP');
  await until(() => procState(h.parent.pid!) === 'T', 'the parent shell is stopped');
  process.kill(h.pid, 'SIGKILL');
  // The leader reads Z while its other threads are still exiting. Wait until only the leader is left.
  await until(() => procState(h.pid) === 'Z' && procStat(h.pid)?.threads === 1, 'the killed holder is a zombie');
  process.kill(h.pid, 0); // A zombie still answers kill(pid, 0); this throws if it was reaped.
  assert.equal(processStartMarker(h.pid), h.holder.startMarker, 'the zombie keeps its start marker');
}

/** Kills the shell's whole group. The orphaned zombie is then reaped by the host's init. */
async function reap(parent: ChildProcess, zombie?: number): Promise<void> {
  if (parent.exitCode === null && parent.signalCode === null) {
    const exited = once(parent, 'exit');
    try { process.kill(-parent.pid!, 'SIGKILL'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; }
    await exited;
  }
  if (zombie !== undefined) {
    for (const end = Date.now() + 10_000; procState(zombie) !== null && Date.now() < end;) await delay(20);
    if (procState(zombie) !== null) process.stderr.write(`issue 26 test: zombie ${zombie} is left for the host init to reap\n`);
  }
}

test('[issue 26] a session lock held by a zombie is taken over, and refused while that holder lived', async () => {
  const lock = join(tempDir('zombie-session'), 'session.lock');
  const h = await startHolder(lock, 'acquire');
  try {
    assert.equal(isAlive(h.holder), true, 'a running holder is alive');
    const early = acquireLock(lock, holderFor(process.pid, 'test', 1000));
    assert.equal(early.status, 'refused', 'a running holder keeps its lock');

    await makeZombie(h);
    const me = holderFor(process.pid, 'test', 1000);
    const got = acquireLock(lock, me);
    assert.equal(got.status, 'acquired', 'a zombie holder no longer keeps its lock');
    assert.ok(got.status === 'acquired' && got.takeoverFrom && got.takeoverFrom !== 'unreadable' && got.takeoverFrom.pid === h.pid, 'the takeover names the zombie');
    assert.equal(isAlive(h.holder), false, 'a zombie holder is dead');
    const now = readLock(lock);
    assert.ok(now && now !== 'unreadable' && now.pid === process.pid && now.generation === me.generation, 'the lock now names this process');
  } finally { await reap(h.parent, h.pid); }
});

test('[issue 26] a serialize lease held by a zombie lets the next call run at once', async () => {
  const lock = join(tempDir('zombie-serialize'), 'codex-prompt.lock');
  const h = await startHolder(lock, 'serialized');
  try {
    assert.throws(() => serialized(lock, () => 'ran', { timeoutMs: 300 }), SerializeTimeout, 'a running holder keeps its lease');

    await makeZombie(h);
    const started = performance.now();
    assert.equal(serialized(lock, () => 'ran', { timeoutMs: 2_000 }), 'ran');
    assert.ok(performance.now() - started < 1_000, 'the next call does not wait out the timeout');
    assert.equal(readLock(lock), null, 'the next call released the lease');
  } finally { await reap(h.parent, h.pid); }
});

test('[issue 26] the next core CLI call runs at once after a zombie held the session operation lease', async () => {
  const f = fixture();
  const run = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args, '--session', 'S26'], {
    cwd: f.projectRoot, encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, CONTEXT_ENGINE_STATE_DIR: f.stateDir, XDG_STATE_HOME: '/nonexistent-should-not-be-used', CONTEXT_ENGINE_EXPERIMENTS: '', CONTEXT_ENGINE_TEST_PROJECT: '' },
  });
  const opened = run('open', '--runner', 'test', '--hard-limit', '5000');
  assert.equal(opened.status, 0, opened.stderr);
  const operation = `${layout(f.projectRoot, 'S26', f.stateDir).lock}.op`;
  const h = await startHolder(operation, 'serialized');
  try {
    await makeZombie(h);
    const started = performance.now();
    const next = run('sync');
    assert.equal(next.status, 0, next.stderr);
    assert.ok(performance.now() - started < 5_000, 'the call does not wait out the 15 s operation timeout');
    assert.equal(readLock(operation), null, 'the call released the operation lease');
  } finally { await reap(h.parent, h.pid); }
});

test('[issue 26] a stopped holder is still alive, and a reused PID still needs its start marker', async () => {
  const lock = join(tempDir('zombie-stopped'), 'session.lock');
  const h = await startHolder(lock, 'acquire');
  try {
    await makeZombie(h);
    const shell = h.parent.pid!;
    const marker = processStartMarker(shell);
    assert.ok(marker, 'the stopped shell has a start marker');
    const stopped: LockHolder = { ...h.holder, pid: shell, startMarker: marker };
    assert.equal(procState(shell), 'T');
    assert.equal(isAlive(stopped), true, 'a stopped process is not dead');
    assert.equal(isAlive({ ...stopped, startMarker: null }), true, 'a holder without a marker on a live PID is alive');
    assert.equal(isAlive({ ...stopped, startMarker: `${marker}0` }), false, 'a live PID with a different start marker is a reused PID');
    assert.equal(isAlive({ ...h.holder, startMarker: null }), false, 'a zombie is dead even when its record has no marker');
  } finally { await reap(h.parent, h.pid); }
});

test('[issue 26] a process whose main thread exited while another thread runs is still alive', { skip: spawnSync('python3', ['-c', 'import ctypes']).status !== 0 && 'python3 with ctypes is not available' }, async () => {
  // /proc shows such a process in state Z, with more than one thread. It can still use a lock.
  const ready = join(tempDir('leader-exit'), 'ready');
  const child = spawn('python3', ['-c', 'import ctypes, sys, threading, time\nthreading.Thread(target=time.sleep, args=(60,)).start()\nopen(sys.argv[1], "w").write("ready")\nctypes.CDLL(None).pthread_exit(None)\n', ready], { stdio: ['ignore', 'ignore', 'inherit'] });
  const exited = once(child, 'exit');
  try {
    await until(() => existsSync(ready) && procState(child.pid!) === 'Z', 'the main thread exited');
    assert.ok(procStat(child.pid!)!.threads >= 2, 'another thread still runs');
    const holder = holderFor(child.pid!, 'test', 1000);
    assert.ok(holder.startMarker, 'the process has a start marker');
    assert.equal(isAlive(holder), true, 'a process with a running thread is alive');
  } finally {
    child.kill('SIGKILL');
    await exited;
  }
});

test('[issue 26] /proc/<pid>/stat parsing fails closed and counts only a fully exited process', async () => {
  const { parseProcessStat } = await import('./platform-linux.ts');
  const stat = (comm: string, state: string, threads: string, start = '4242') =>
    `77 (${comm}) ${state} 1 77 77 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 ${threads} 0 ${start} 0 0`;
  assert.deepEqual(parseProcessStat(stat('node', 'Z', '1')), { state: 'Z', threads: 1, startMarker: '4242' });
  // A command name may hold spaces and parentheses; the fields start after the last ')'.
  assert.deepEqual(parseProcessStat(stat('a) Z 1 (b', 'S', '1')), { state: 'S', threads: 1, startMarker: '4242' });
  for (const bad of ['', 'garbage', '77 (node)', stat('node', 'Z', 'x'), stat('node', 'ZZ', '1'), stat('node', 'Z', '1', ''), stat('node', 'Z', '1', '12a')]) {
    assert.equal(parseProcessStat(bad), null, `refuses ${JSON.stringify(bad)}`);
  }
});
