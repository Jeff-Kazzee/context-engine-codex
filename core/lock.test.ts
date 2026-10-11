// Stale-lock takeover under contention. Each contender is a real process; the lock-step seam
// (faults.ts) pauses a contender at an exact point so the schedule is deterministic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './testing.ts';
import { readLock } from './lock.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

// A contender: runs `serialized` (or `acquireLock`) on the lock path. At each lock step it drops a
// marker file; at the steps named in PAUSE it waits for a `.go` file. Inside the operation it
// records whether anyone else was inside, then waits for a `.leave` file.
const CONTENDER = `
import { existsSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [lockPath, name, sig, mode, pauseList] = process.argv.slice(1);
const { setLockStepHook } = await import(${JSON.stringify(join(here, 'faults.ts'))});
const { serialized, acquireLock, holderFor } = await import(${JSON.stringify(join(here, 'lock.ts'))});
const pause = new Set(pauseList ? pauseList.split(',') : []);
const nap = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
const waitFile = (p) => { while (!existsSync(p)) nap(); };
setLockStepHook((step) => {
  writeFileSync(join(sig, name + '.' + step), '');
  if (pause.delete(step)) waitFile(join(sig, name + '.' + step + '.go'));
});
const inside = () => {
  const others = readdirSync(sig).filter((f) => f.endsWith('.inside'));
  if (others.length) writeFileSync(join(sig, name + '.overlap'), others.join(','));
  writeFileSync(join(sig, name + '.inside'), '');
  writeFileSync(join(sig, name + '.in'), '');
  waitFile(join(sig, name + '.leave'));
  unlinkSync(join(sig, name + '.inside'));
};
if (mode === 'serialized') serialized(lockPath, inside, { timeoutMs: 30_000 });
else {
  const got = acquireLock(lockPath, holderFor(process.pid, 'test', 1000));
  writeFileSync(join(sig, name + '.' + got.status), '');
  waitFile(join(sig, name + '.leave'));
}
`;

function contender(lockPath: string, name: string, sig: string, mode: 'serialized' | 'acquire', pause: string[] = []): ChildProcess {
  const child = spawn(process.execPath, ['--input-type=module', '-e', CONTENDER, lockPath, name, sig, mode, pause.join(',')], { stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr!.on('data', (d) => process.stderr.write(`[${name}] ${d}`));
  return child;
}

/** Waits until one of the marker files exists; returns which. */
async function waitAny(sig: string, names: string[], ms = 20_000): Promise<string> {
  const end = Date.now() + ms;
  for (;;) {
    const hit = names.find((n) => existsSync(join(sig, n)));
    if (hit) return hit;
    if (Date.now() > end) throw new Error(`timed out waiting for ${names.join(' | ')}; have ${readdirSync(sig).join(', ')}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

function deadLock(path: string): void {
  const dead = spawnSync(process.execPath, ['-e', '0']).pid!;
  writeFileSync(path, JSON.stringify({ pid: dead, hostname: hostname(), startMarker: null, runner: 'serialize', hardLimit: 0, acquiredAt: new Date(0).toISOString() }));
}

test('stale takeover with three contenders: a waiter that saw a dead holder never removes the live lock that replaced it', async () => {
  const dir = tempDir('lock3');
  const sig = tempDir('lock3-sig');
  const lock = join(dir, 'lock.op');
  deadLock(lock);
  const kids: ChildProcess[] = [];
  try {
    // W observes the dead holder and stops right there.
    const w = contender(lock, 'W', sig, 'serialized', ['stale-seen', 'stale-removing']);
    kids.push(w);
    await waitAny(sig, ['W.stale-seen']);
    // X takes the dead lock over and is inside its operation.
    kids.push(contender(lock, 'X', sig, 'serialized'));
    await waitAny(sig, ['X.in']);
    // W resumes acting on what it saw. It must find X alive and wait, never touch X's lock.
    writeFileSync(join(sig, 'W.stale-seen.go'), '');
    const wNext = await waitAny(sig, ['W.stale-removing', 'W.live-wait']);
    // A third contender arrives while W is wherever it got to.
    kids.push(contender(lock, 'Y', sig, 'serialized'));
    await waitAny(sig, ['Y.in', 'Y.live-wait']);
    if (wNext === 'W.stale-removing') writeFileSync(join(sig, 'W.stale-removing.go'), '');
    // Let everyone finish, one leave at a time.
    for (const n of ['X', 'Y', 'W']) writeFileSync(join(sig, `${n}.leave`), '');
    await Promise.all(kids.map((k) => (k.exitCode === null ? once(k, 'exit') : null)));
    for (const k of kids) assert.equal(k.exitCode, 0);
    const overlaps = readdirSync(sig).filter((f) => f.endsWith('.overlap'));
    assert.deepEqual(overlaps, [], 'two contenders were inside the serialized operation at once');
    for (const n of ['W', 'X', 'Y']) assert.ok(existsSync(join(sig, `${n}.in`)), `${n} ran its operation`);
  } finally {
    for (const k of kids) k.kill('SIGKILL');
  }
});

test('session lock: two contenders that both saw the same dead holder cannot both acquire', async () => {
  const dir = tempDir('lock2');
  const sig = tempDir('lock2-sig');
  const lock = join(dir, 'lock');
  deadLock(lock);
  const kids = ['A', 'B'].map((n) => contender(lock, n, sig, 'acquire', ['stale-seen']));
  try {
    await waitAny(sig, ['A.stale-seen']);
    await waitAny(sig, ['B.stale-seen']);
    writeFileSync(join(sig, 'A.stale-seen.go'), '');
    writeFileSync(join(sig, 'B.stale-seen.go'), '');
    const a = await waitAny(sig, ['A.acquired', 'A.refused']);
    const b = await waitAny(sig, ['B.acquired', 'B.refused']);
    assert.deepEqual([a, b].filter((r) => r.endsWith('.acquired')).length, 1, `exactly one acquires (got ${a}, ${b})`);
  } finally {
    for (const n of ['A', 'B']) writeFileSync(join(sig, `${n}.leave`), '');
    for (const k of kids) k.kill('SIGKILL');
  }
});

// Two handles of one owner: the releaser stops between its release check and its unlink, and the
// replacer releases the same lifetime and publishes a new one in that window.
const RELEASE_RACE = `
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [role, lockPath, sig, owner] = process.argv.slice(1);
const { setLockStepHook } = await import(${JSON.stringify(join(here, 'faults.ts'))});
const { acquireLock, releaseLock, holderFor } = await import(${JSON.stringify(join(here, 'lock.ts'))});
const nap = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
const me = holderFor(Number(owner), role, 1000);
if (acquireLock(lockPath, me).status !== 'acquired') process.exit(3);
if (role === 'releaser') {
  setLockStepHook((step) => {
    if (step !== 'release-checked') return;
    writeFileSync(join(sig, 'releaser.checked'), '');
    while (!existsSync(join(sig, 'releaser.go'))) nap();
  });
  releaseLock(lockPath, me);
} else {
  releaseLock(lockPath, me);
  const next = holderFor(Number(owner), role, 1000);
  const got = acquireLock(lockPath, next);
  writeFileSync(join(sig, 'replacer.done'), JSON.stringify({ status: got.status, generation: next.generation }));
}
`;

test('a release cannot remove a lock lifetime published between its check and its unlink', async () => {
  const lockPath = join(tempDir('release-race'), 'session.lock'), sig = tempDir('release-race-sig');
  const run = (role: string) => spawn(process.execPath, ['--input-type=module', '-e', RELEASE_RACE, role, lockPath, sig, String(process.pid)], { stdio: ['ignore', 'ignore', 'inherit'] });
  const kids: ChildProcess[] = [];
  try {
    kids.push(run('releaser'));
    await waitAny(sig, ['releaser.checked']);
    kids.push(run('replacer'));
    // The replacer either finishes in the window or waits for the releaser to leave it.
    await waitAny(sig, ['replacer.done'], 1500).catch(() => undefined);
    writeFileSync(join(sig, 'releaser.go'), '');
    await Promise.all(kids.map((k) => (k.exitCode === null ? once(k, 'exit') : null)));
    for (const k of kids) assert.equal(k.exitCode, 0);
    const published = JSON.parse(readFileSync(join(sig, 'replacer.done'), 'utf8'));
    assert.equal(published.status, 'acquired');
    const current = readLock(lockPath);
    assert.ok(current && current !== 'unreadable', 'the lifetime the replacer published was removed');
    assert.equal(current.generation, published.generation);
  } finally {
    writeFileSync(join(sig, 'releaser.go'), '');
    for (const k of kids) k.kill('SIGKILL');
  }
});
