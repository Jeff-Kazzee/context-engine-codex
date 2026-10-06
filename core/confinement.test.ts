// Path confinement against symlinks and hard links (review finding 2). Every secret here is
// synthetic, in a temp HOME; nothing touches the real home directory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkRefs } from './refs.ts';
import { cite, openSession, readWorkingContext, type Session } from './index.ts';
import { fixture, tempDir } from './testing.ts';
import { setConfineHook, setProcFdDir } from './faults.ts';

const SECRET = 'SYNTHETIC-SECRET-7f3a9c';

/** A temp HOME holding synthetic credential files, set as $HOME for this test file. */
function fakeHome(): string {
  const home = tempDir('home');
  mkdirSync(join(home, '.codex'));
  writeFileSync(join(home, '.codex', 'auth.json'), `{"token":"${SECRET}"}\n`);
  mkdirSync(join(home, '.claude'));
  writeFileSync(join(home, '.claude', '.credentials.json'), `{"token":"${SECRET}"}\n`);
  mkdirSync(join(home, '.ssh'));
  writeFileSync(join(home, '.ssh', 'id_ed25519'), `${SECRET}\n`);
  process.env.HOME = home;
  return home;
}

function open(f: ReturnType<typeof fixture>, extra: Record<string, unknown> = {}): Session {
  const r = openSession({ ...f, sessionId: 'S1', runner: 'test', hardLimit: 10_000, ...extra });
  assert.equal(r.status, 'open');
  return r.session;
}

/** Every file under `dir`, read as text (to prove a secret was never copied there). */
function allText(dir: string): string {
  let out = '';
  for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (e.isFile()) out += readFileSync(join(e.parentPath, e.name), 'utf8');
  }
  return out;
}

test('cite refuses a path that leaves the project through a symlink', () => {
  const home = fakeHome();
  const f = fixture();
  symlinkSync(home, join(f.projectRoot, 'homelink'));
  assert.throws(() => cite(f.projectRoot, 'homelink/.codex/auth.json'), /not inside the project/);
});

test('cite refuses credential files even when the project root contains them', () => {
  const home = fakeHome();
  assert.throws(() => cite(home, '.codex/auth.json'), /credential/);
  assert.throws(() => cite(home, '.claude/.credentials.json'), /credential/);
  assert.throws(() => cite(home, '.ssh/id_ed25519'), /credential/);
});

test('stale-reference checks never read a file reached through a symlink out of the project', () => {
  const home = fakeHome();
  const f = fixture();
  symlinkSync(home, join(f.projectRoot, 'homelink'));
  // A hand-written marker (cite would refuse it). Reading the target would report it 'changed'.
  assert.equal(checkRefs(f.projectRoot, '⟦src:homelink/.codex/auth.json@00000000⟧'), undefined);
  assert.equal(checkRefs(home, '⟦src:.codex/auth.json@00000000⟧'), undefined, 'credential files are never read');
});

test('read refuses a Working Context that is a symlink, and never prints its target', () => {
  const home = fakeHome();
  const f = fixture();
  const s = open(f);
  s.close();
  symlinkSync(join(home, '.codex', 'auth.json'), s.workingContextPath);
  let out = '';
  assert.throws(() => (out = readWorkingContext({ ...f, sessionId: 'S1' }).text), /symbolic link|not a regular file/);
  assert.ok(!out.includes(SECRET));
});

test('sync never commits what a symlinked Working Context points at, and replaces the link', () => {
  const home = fakeHome();
  const f = fixture();
  const s = open(f);
  writeFileSync(s.workingContextPath, 'Task: build the parser.\n');
  assert.equal(s.sync().revision, 1);
  const wc = s.workingContextPath;
  // Swap the file for a link to the credential file.
  symlinkSync(join(home, '.codex', 'auth.json'), `${wc}.link`);
  renameSync(`${wc}.link`, wc);
  const r = s.sync();
  assert.equal(r.revision, 1, 'nothing new committed');
  assert.equal(r.receipt?.kind, 'restored');
  assert.ok(!lstatSync(wc).isSymbolicLink(), 'the link was replaced by the restored revision');
  assert.equal(readFileSync(wc, 'utf8'), 'Task: build the parser.\n');
  assert.ok(!allText(f.stateDir).includes(SECRET), 'the secret is nowhere in the session state');
  assert.ok(readFileSync(join(home, '.codex', 'auth.json'), 'utf8').includes(SECRET), 'the target is untouched');
});

test('sync never commits a Working Context hard-linked to a credential file', () => {
  const home = fakeHome();
  const f = fixture();
  const s = open(f);
  writeFileSync(s.workingContextPath, 'Task: build the parser.\n');
  s.sync();
  const wc = s.workingContextPath;
  unlinkSync(wc);
  linkSync(join(home, '.codex', 'auth.json'), wc);
  const r = s.sync();
  assert.equal(r.revision, 1);
  assert.ok(!allText(f.stateDir).includes(SECRET), 'the secret is nowhere in the session state');
  assert.ok(readFileSync(join(home, '.codex', 'auth.json'), 'utf8').includes(SECRET), 'the credential file is untouched');
  assert.equal(statSync(join(home, '.codex', 'auth.json')).nlink, 1, 'the link was replaced, not written through');
});

test('a session directory that is a symlink out of the project is refused, nothing read or written there', () => {
  const home = fakeHome();
  const f = fixture();
  mkdirSync(join(f.projectRoot, '.context-engine'), { recursive: true });
  symlinkSync(join(home, '.codex'), join(f.projectRoot, '.context-engine', 'S1'));
  writeFileSync(join(home, '.codex', 'context.md'), SECRET);
  assert.throws(() => open(f), /symbolic link|outside/);
  assert.throws(() => readWorkingContext({ ...f, sessionId: 'S1' }), /symbolic link|outside|no session/);
  assert.equal(readFileSync(join(home, '.codex', 'context.md'), 'utf8'), SECRET, 'not overwritten');
  assert.deepEqual(readdirSync(join(home, '.codex')).sort(), ['auth.json', 'context.md']);
});

// ---- review round 2, finding 1: the file (or a directory above it) is swapped between the
// path checks and the open. The swap runs from the core's own `before-open` seam, so the race
// is hit every time.

/** How many armed swaps have run (each test checks its own ran, outside any assert.throws). */
let swapsRun = 0;

/** Runs `fn` with a one-shot swap armed at the core's before-open step. */
function withSwap<T>(swap: (path: string) => void, fn: () => T): T {
  let fired = false;
  setConfineHook((step, path) => {
    if (step !== 'before-open' || fired) return;
    fired = true;
    swapsRun++;
    swap(path);
  });
  try {
    return fn();
  } finally {
    setConfineHook(null);
  }
}

/** Asserts that `n` more swaps ran since `before`. */
function ran(before: number, n = 1): void {
  assert.equal(swapsRun - before, n, 'the swap ran at the before-open step');
}

/** Replaces `path` (a file or directory) with a symbolic link to `target`, atomically. */
function swapForLink(path: string, target: string): void {
  renameSync(path, `${path}.moved`);
  symlinkSync(target, path);
}

test('cite never reads a credential swapped in for the checked file before it is opened', () => {
  const home = fakeHome();
  const f = fixture();
  const file = join(f.projectRoot, 'notes.txt');
  writeFileSync(file, 'ordinary\n');
  let out = '';
  const before = swapsRun;
  assert.throws(() => (out = withSwap(() => swapForLink(file, join(home, '.codex', 'auth.json')), () => cite(f.projectRoot, 'notes.txt'))), /not inside the project|credential|not a regular file/);
  ran(before);
  assert.ok(!out.includes(SECRET));
});

test('cite never reads through a directory swapped for a link out of the project before the open', () => {
  const home = fakeHome();
  const f = fixture();
  mkdirSync(join(f.projectRoot, 'sub'));
  writeFileSync(join(f.projectRoot, 'sub', 'auth.json'), 'ordinary\n');
  const plain = cite(f.projectRoot, 'sub/auth.json');
  let out = '';
  const before = swapsRun;
  assert.throws(() => (out = withSwap(() => swapForLink(join(f.projectRoot, 'sub'), join(home, '.codex')), () => cite(f.projectRoot, 'sub/auth.json'))), /not inside the project|credential/);
  ran(before);
  assert.notEqual(out, plain);
});

test('stale-reference checks never read a credential swapped in for the cited file or a directory above it', () => {
  const home = fakeHome();
  const f = fixture();
  writeFileSync(join(f.projectRoot, 'notes.txt'), 'ordinary\n');
  mkdirSync(join(f.projectRoot, 'sub'));
  writeFileSync(join(f.projectRoot, 'sub', 'auth.json'), 'ordinary\n');
  const fileMarker = cite(f.projectRoot, 'notes.txt');
  const dirMarker = cite(f.projectRoot, 'sub/auth.json');
  // Reading the credential instead would report the marker 'changed'.
  const before = swapsRun;
  assert.equal(withSwap(() => swapForLink(join(f.projectRoot, 'notes.txt'), join(home, '.codex', 'auth.json')), () => checkRefs(f.projectRoot, fileMarker)), undefined);
  assert.equal(withSwap(() => swapForLink(join(f.projectRoot, 'sub'), join(home, '.codex')), () => checkRefs(f.projectRoot, dirMarker)), undefined);
  ran(before, 2);
});

test('read never prints a file reached through a session directory swapped for a link after the directory check', () => {
  const home = fakeHome();
  const f = fixture();
  const s = open(f);
  writeFileSync(s.workingContextPath, 'Task: build the parser.\n');
  s.sync();
  s.close();
  writeFileSync(join(home, '.codex', 'context.md'), `${SECRET}\n`);
  const sessionDir = join(f.projectRoot, '.context-engine', 'S1');
  let out = '';
  const before = swapsRun;
  assert.throws(() => (out = withSwap(() => swapForLink(sessionDir, join(home, '.codex')), () => readWorkingContext({ ...f, sessionId: 'S1' }).text)), /changed while|symbolic link|outside/);
  ran(before);
  assert.ok(!out.includes(SECRET));
});

test('sync never commits a file reached through a session directory swapped for a link after the directory check', () => {
  const home = fakeHome();
  const f = fixture();
  const s = open(f);
  writeFileSync(s.workingContextPath, 'Task: build the parser.\n');
  assert.equal(s.sync().revision, 1);
  writeFileSync(join(home, '.codex', 'context.md'), `${SECRET}\n`);
  const sessionDir = join(f.projectRoot, '.context-engine', 'S1');
  const before = swapsRun;
  try {
    const r = withSwap(() => swapForLink(sessionDir, join(home, '.codex')), () => s.sync());
    assert.equal(r.revision, 1, 'nothing new committed');
  } catch (e) {
    assert.match(String(e), /changed while|symbolic link|outside/);
  }
  ran(before);
  assert.ok(!allText(f.stateDir).includes(SECRET), 'the secret is nowhere in the session state');
  assert.equal(readFileSync(join(home, '.codex', 'context.md'), 'utf8'), `${SECRET}\n`, 'the target is untouched');
});

test('without /proc/self/fd a confined read fails closed: nothing is read, cite and read refuse', () => {
  fakeHome();
  const f = fixture();
  writeFileSync(join(f.projectRoot, 'notes.txt'), 'ordinary\n');
  const s = open(f);
  writeFileSync(s.workingContextPath, 'Task: build the parser.\n');
  s.sync();
  s.close();
  setProcFdDir(join(tempDir('noproc'), 'missing'));
  try {
    assert.throws(() => cite(f.projectRoot, 'notes.txt'), /cannot verify/);
    assert.throws(() => readWorkingContext({ ...f, sessionId: 'S1' }), /cannot verify/);
  } finally {
    setProcFdDir(null);
  }
  assert.match(cite(f.projectRoot, 'notes.txt'), /^⟦src:notes\.txt@[0-9a-f]{8}⟧$/);
});
