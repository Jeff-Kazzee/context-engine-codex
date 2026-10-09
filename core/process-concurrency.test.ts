// Concurrency across real processes: CLI processes, owner processes and this test process act on
// one project or one session at the same time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openSession, parseTurns, recall, SerializeTimeout, withSessionSerialized } from './index.ts';
import { processStartMarker, readLock } from './lock.ts';
import { layout, type Layout } from './store.ts';
import { eventLog, fixture, ownerProcess, startCli, stopGroup, tempDir, waitForFile } from './testing.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const opening = ['--session', 'S1', '--runner', 'test', '--hard-limit', '10000'];
const event = (text: string) => JSON.stringify({ role: 'tool', text });
const count = (text: string, needle: string) => text.split(needle).length - 1;
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

/** The bytes of every session file a call could change, by path. */
function sessionFiles(l: Layout): Record<string, string> {
  const paths = [l.events, l.head, l.lock, l.workingContext, ...readdirSync(l.revisions).map((n) => join(l.revisions, n))];
  return Object.fromEntries(paths.map((p) => [p, readFileSync(p).toString('base64')]));
}

function openFor(f: ReturnType<typeof fixture>, sessionId: string, ownerPid?: number) {
  const r = openSession({ ...f, sessionId, runner: 'test', hardLimit: 10_000, ...(ownerPid ? { ownerPid } : {}) });
  assert.equal(r.status, 'open');
  return r.session;
}

test('[CORE-024] concurrent CLI records leave a valid strictly increasing Event Log', { timeout: 60_000 }, async () => {
  const f = fixture();
  const owner = ownerProcess();
  try {
    const args = ['record', ...opening, '--owner-pid', String(owner.pid)];
    assert.equal((await startCli(f, args, { input: event('Task.') }).done).code, 0);
    const runs = await Promise.all(range(8).map((i) => startCli(f, args, { input: event(`check-${i}`) }).done));
    for (const r of runs) assert.equal(r.code, 0, r.stdout + r.stderr);

    const l = layout(f.projectRoot, 'S1', f.stateDir);
    const rows = eventLog(l.events);
    const batches = rows.filter((r) => r.type === 'runner-events');
    assert.equal(batches.length, 9, 'one runner-events row per call');
    assert.deepEqual(batches.flatMap((r) => r.events.map((e: { seq: number }) => e.seq)), range(9), 'sequences 1..9 in file order');
    for (const type of ['revision', 'revision-prepared']) assert.deepEqual(rows.filter((r) => r.type === type).map((r) => r.rev), range(9), `one ${type} row per revision`);
    const text = readFileSync(l.workingContext, 'utf8');
    for (const i of range(8)) assert.equal(count(text, `check-${i}\n`), 1, `check-${i} recorded once`);

    rmSync(join(l.stateDir, 'recovery.json'));
    const reopened = await startCli(f, ['sync', ...opening, '--owner-pid', String(owner.pid)]).done;
    assert.equal(reopened.code, 0, reopened.stdout + reopened.stderr);
    assert.equal(JSON.parse(reopened.stdout).revision, 9);
    assert.equal(readFileSync(l.workingContext, 'utf8'), text, 'a cold reopen rebuilds the same Working Context');
  } finally {
    await stopGroup(owner);
  }
});

test('[CORE-024] mixed sync, record and native-compaction calls serialize', { timeout: 60_000 }, async () => {
  const f = fixture();
  const owner = ownerProcess();
  try {
    const own = [...opening, '--owner-pid', String(owner.pid)];
    assert.equal((await startCli(f, ['record', ...own], { input: event('FIRST') }).done).code, 0);
    const l = layout(f.projectRoot, 'S1', f.stateDir);
    writeFileSync(l.workingContext, `${readFileSync(l.workingContext, 'utf8')}\n[[CTX_TURN 2 role=notes]]\nMODEL_EDIT\n`);
    const calls = [
      ...range(4).map((i) => startCli(f, ['record', ...own], { input: event(`MIXED_${i}`) })),
      ...range(2).map(() => startCli(f, ['sync', ...own])),
      startCli(f, ['native-compaction', ...own], { input: JSON.stringify({ role: 'assistant', text: 'COMPACTION_SUMMARY' }) }),
    ];
    for (const r of await Promise.all(calls.map((c) => c.done))) assert.equal(r.code, 0, r.stdout + r.stderr);

    const rows = eventLog(l.events);
    const batches = rows.filter((r) => r.type === 'runner-events');
    assert.deepEqual(batches.flatMap((r) => r.events.map((e: { seq: number }) => e.seq)), range(6), 'strictly increasing sequences, one per event');
    const head = JSON.parse(readFileSync(l.head, 'utf8'));
    assert.equal(head.rev, readdirSync(l.revisions).length, 'HEAD names the last revision');
    const snapshot = readFileSync(join(l.revisions, `${head.rev}.md`), 'utf8');
    assert.equal(sha(snapshot), head.sha);
    assert.equal(readFileSync(l.workingContext, 'utf8'), snapshot);
    // The compaction replaced everything logged before it. Later appends follow its summary once each.
    const compaction = batches.findIndex((b) => b.replace);
    assert.ok(compaction >= 0);
    batches.forEach((b, i) => {
      for (const e of b.events) assert.equal(count(snapshot, e.event.text), i >= compaction ? 1 : 0, e.event.text);
    });
    if (compaction === batches.length - 1) assert.deepEqual(parseTurns(snapshot), [{ role: 'assistant', text: 'COMPACTION_SUMMARY' }]);
    assert.equal(count(snapshot, 'MODEL_EDIT'), 0);
    assert.ok(readdirSync(l.revisions).some((n) => readFileSync(join(l.revisions, n), 'utf8').includes('MODEL_EDIT')), 'the model edit was committed first');
  } finally {
    await stopGroup(owner);
  }
});

test('[CORE-021] a refused CLI call changes no session state', { timeout: 30_000 }, async () => {
  const f = fixture();
  const holder = ownerProcess();
  try {
    assert.equal((await startCli(f, ['record', ...opening, '--owner-pid', String(holder.pid)], { input: event('HELD') }).done).code, 0);
    const l = layout(f.projectRoot, 'S1', f.stateDir);
    const before = sessionFiles(l);
    for (const args of [['record', '--session', 'S1'], ['record', ...opening], ['sync', ...opening]]) {
      const r = await startCli(f, args, { input: event('REFUSED_SENTINEL') }).done;
      assert.equal(r.code, 2, r.stdout + r.stderr);
      const json = JSON.parse(r.stdout);
      assert.equal(json.error, 'refused');
      assert.equal(json.holder.pid, holder.pid);
    }
    assert.deepEqual(sessionFiles(l), before);
  } finally {
    await stopGroup(holder);
  }
});

// Holds the S1 operation lock (<state>/lock.op) until <sig>/leave exists.
const HOLD_OPERATION = `
import { existsSync, writeFileSync } from 'node:fs';
const [projectRoot, stateDir, sig] = process.argv.slice(1);
const { withSessionSerialized } = await import(${JSON.stringify(join(here, 'session.ts'))});
withSessionSerialized({ projectRoot, sessionId: 'S1', stateDir }, () => {
  writeFileSync(sig + '/in', '');
  const deadline = Date.now() + 60_000;
  while (!existsSync(sig + '/leave') && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
});
`;

test('[CORE-022] a live operation-lock holder makes withSessionSerialized and the CLI time out without running', { timeout: 60_000 }, async () => {
  const f = fixture();
  assert.equal((await startCli(f, ['record', ...opening], { input: event('BEFORE') }).done).code, 0);
  const l = layout(f.projectRoot, 'S1', f.stateDir);
  const before = sessionFiles(l);
  const sig = tempDir('op-holder');
  const holder = spawn(process.execPath, ['--input-type=module', '-e', HOLD_OPERATION, f.projectRoot, f.stateDir, sig], { stdio: 'ignore', detached: true });
  try {
    await waitForFile(join(sig, 'in'));
    const busy = startCli(f, ['record', ...opening], { input: event('BUSY_SENTINEL') });
    let ran = false;
    const started = Date.now();
    assert.throws(() => withSessionSerialized({ ...f, sessionId: 'S1' }, () => { ran = true; }), SerializeTimeout);
    const waited = Date.now() - started;
    assert.ok(waited >= 15_000 && waited < 17_000, `waited ${waited} ms`);
    assert.equal(ran, false, 'the operation never ran');

    const cli = await busy.done;
    assert.equal(cli.code, 1, cli.stderr);
    const lines = cli.stdout.trim().split('\n');
    assert.equal(lines.length, 1);
    const json = JSON.parse(lines[0]!);
    assert.equal(json.ok, false);
    assert.match(json.error, /session busy/);
    assert.deepEqual(sessionFiles(l), before, 'neither call changed the session');

    writeFileSync(join(sig, 'leave'), '');
    await once(holder, 'exit');
    const again = Date.now();
    withSessionSerialized({ ...f, sessionId: 'S1' }, () => { ran = true; });
    assert.ok(ran && Date.now() - again < 1_000, 'a free operation lock admits the next call at once');
  } finally {
    await stopGroup(holder);
  }
});

function lockRecord(l: Layout, holder: { pid: number; hostname: string; startMarker: string | null }) {
  writeFileSync(l.lock, JSON.stringify({ ...holder, runner: 'test', hardLimit: 10_000, acquiredAt: new Date().toISOString() }));
}

test('[CORE-023] a lock whose live pid has a different start marker is taken over', { timeout: 30_000 }, async () => {
  const f = fixture();
  const first = openFor(f, 'S1');
  first.record([{ role: 'user', text: 'Task.' }]);
  first.close();
  const l = layout(f.projectRoot, 'S1', f.stateDir);
  const child = ownerProcess();
  try {
    const marker = processStartMarker(child.pid!);
    assert.match(marker ?? '', /^\d+$/, 'this host reports process start markers');
    lockRecord(l, { pid: child.pid!, hostname: hostname(), startMarker: '0' });
    const taken = openFor(f, 'S1');
    const takeovers = eventLog(l.events).filter((r) => r.type === 'lock-takeover');
    assert.equal(takeovers.length, 1);
    assert.equal(takeovers[0]!.from.pid, child.pid);
    assert.equal(takeovers[0]!.from.startMarker, '0');
    taken.close();

    lockRecord(l, { pid: child.pid!, hostname: hostname(), startMarker: marker });
    const refused = openSession({ ...f, sessionId: 'S1', runner: 'test', hardLimit: 10_000 });
    assert.equal(refused.status, 'refused');
    assert.equal(refused.status === 'refused' && refused.holder.pid, child.pid);
  } finally {
    await stopGroup(child);
  }
});

test('[CORE-023] a lock recorded under another hostname is refused and reported', { timeout: 30_000 }, async () => {
  const f = fixture();
  const first = openFor(f, 'S1');
  first.record([{ role: 'user', text: 'Task.' }]);
  first.close();
  const l = layout(f.projectRoot, 'S1', f.stateDir);
  const dead = spawnSync(process.execPath, ['-e', '0']).pid!;
  lockRecord(l, { pid: dead, hostname: 'other-host', startMarker: null });
  const before = sessionFiles(l);

  const refused = openSession({ ...f, sessionId: 'S1', runner: 'test', hardLimit: 10_000 });
  assert.equal(refused.status, 'refused');
  assert.equal(refused.status === 'refused' && refused.holder.hostname, 'other-host');
  const status = await startCli(f, ['status', '--session', 'S1']).done;
  assert.equal(status.code, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).lock.hostname, 'other-host');
  assert.equal(JSON.parse(status.stdout).lock.live, true, 'a holder on another host is presumed alive');
  assert.deepEqual(sessionFiles(l), before);
});

test('[CORE-026] a live foreign owner of S1 does not block a second owner of S2', { timeout: 30_000 }, async () => {
  const f = fixture();
  const holder = ownerProcess();
  try {
    const s1 = openFor(f, 'S1', holder.pid);
    s1.record([{ role: 'user', text: 'S1_ONLY' }]);
    assert.equal(openSession({ ...f, sessionId: 'S1', runner: 'test', hardLimit: 10_000 }).status, 'refused', 'S1 is held');
    const s2 = openFor(f, 'S2');
    s2.record([{ role: 'user', text: 'S2_ONLY' }]);

    const [l1, l2] = ['S1', 'S2'].map((s) => layout(f.projectRoot, s, f.stateDir)) as [Layout, Layout];
    const lock1 = readLock(l1.lock), lock2 = readLock(l2.lock);
    assert.equal(lock1 !== null && lock1 !== 'unreadable' && lock1.pid, holder.pid);
    assert.equal(lock2 !== null && lock2 !== 'unreadable' && lock2.pid, process.pid);
    const log1 = readFileSync(l1.events, 'utf8'), log2 = readFileSync(l2.events, 'utf8');
    assert.ok(log1.includes('S1_ONLY') && !log1.includes('S2_ONLY'));
    assert.ok(log2.includes('S2_ONLY') && !log2.includes('S1_ONLY'));
    s2.close();
  } finally {
    await stopGroup(holder);
  }
});

test('[CORE-024] first-ever concurrent calls on a fresh session all succeed', { timeout: 60_000 }, async () => {
  const f = fixture();
  const owner = ownerProcess();
  const sig = tempDir('gitignore-sig');
  const args = ['record', ...opening, '--owner-pid', String(owner.pid)];
  const runs = [startCli(f, args, { input: event('FRESH_0'), fault: { call: 'writeFileSync', path: '/\\.context-engine/\\.gitignore$', at: 'before', action: 'block', dir: sig } })];
  try {
    await waitForFile(join(sig, 'blocked'));
    for (let i = 1; i < 8; i++) runs.push(startCli(f, args, { input: event(`FRESH_${i}`) }));
    await new Promise((r) => setTimeout(r, 750));
    writeFileSync(join(sig, 'release'), '');
    const results = await Promise.all(runs.map((r) => r.done));
    results.forEach((r, i) => assert.equal(r.code, 0, `call ${i}: ${r.stdout}${r.stderr}`));

    const ignore = readFileSync(join(f.projectRoot, '.context-engine', '.gitignore'), 'utf8');
    assert.equal(ignore.trim().split('\n').at(-1), '*');
    const l = layout(f.projectRoot, 'S1', f.stateDir);
    const text = readFileSync(l.workingContext, 'utf8');
    for (let i = 0; i < 8; i++) assert.equal(count(text, `FRESH_${i}\n`), 1, `FRESH_${i} recorded once`);
    assert.equal(JSON.parse(readFileSync(l.head, 'utf8')).rev, 8);
  } finally {
    for (const r of runs) await stopGroup(r.child);
    await stopGroup(owner);
  }
});

test('[CORE-005] a model write racing materialization is committed or logged, never lost', { timeout: 30_000 }, async () => {
  const f = fixture();
  const sig = tempDir('race-sig');
  assert.equal((await startCli(f, ['record', ...opening], { input: event('BASE') }).done).code, 0);
  const l = layout(f.projectRoot, 'S1', f.stateDir);
  const racing = startCli(f, ['record', ...opening], {
    input: event('APPEND_SENTINEL'),
    fault: { call: 'openSync', path: '/context\\.md\\.ce-\\d+-[0-9a-f]{8}\\.tmp$', at: 'before', action: 'block', dir: sig },
  });
  try {
    await waitForFile(join(sig, 'blocked'));
    writeFileSync(l.workingContext, `${readFileSync(l.workingContext, 'utf8')}\n[[CTX_TURN 2 role=notes]]\nRACE_SENTINEL\n`);
    writeFileSync(join(sig, 'release'), '');
    const r = await racing.done;
    assert.equal(r.code, 0, r.stdout + r.stderr);

    const committed = readdirSync(l.revisions).some((n) => readFileSync(join(l.revisions, n), 'utf8').includes('RACE_SENTINEL'));
    const logged = eventLog(l.events).some((row) => row.type === 'restored' && String(row.rejected).includes('RACE_SENTINEL'));
    const receipt = JSON.parse(r.stdout).receipt;
    assert.ok(committed || (logged && receipt?.kind === 'restored'), `RACE_SENTINEL was ${committed ? 'committed' : logged ? 'logged without a receipt' : 'lost: in no revision and no Event Log row'}`);
    assert.equal(count(readFileSync(l.workingContext, 'utf8'), 'APPEND_SENTINEL'), 1, 'the runner append is kept too');
  } finally {
    await stopGroup(racing.child);
  }
});

// Writes <sig>/<name>-ready, then calls sessionFrameKey on each directory as soon as <sig>/go-<i>
// exists, and writes what it got.
const FRAME_KEY_RACER = `
import { existsSync, writeFileSync } from 'node:fs';
const [dirs, sig, name] = process.argv.slice(1);
const { sessionFrameKey } = await import(${JSON.stringify(join(here, 'store.ts'))});
const list = JSON.parse(dirs);
writeFileSync(sig + '/' + name + '-ready', '');
for (let i = 0; i < list.length; i++) {
  const deadline = Date.now() + 20_000;
  while (!existsSync(sig + '/go-' + i)) if (Date.now() > deadline) process.exit(3);
  let got;
  try { got = sessionFrameKey(list[i]); } catch (e) { got = 'ERROR ' + e.message; }
  writeFileSync(sig + '/' + name + '-' + i, got);
}
`;

test('[CORE-015] a process reading the frame key while another publishes it gets the whole key', { timeout: 30_000 }, async () => {
  const f = fixture();
  const sig = tempDir('frame-key-publish');
  const publisher = startCli(f, ['open', ...opening], { fault: { call: 'linkSync', path: '/frame-key$', at: 'after', action: 'block', dir: sig } });
  const l = layout(f.projectRoot, 'S1', f.stateDir);
  let reader: ReturnType<typeof spawn> | undefined;
  try {
    await waitForFile(join(sig, 'blocked'));
    reader = spawn(process.execPath, ['--input-type=module', '-e', FRAME_KEY_RACER, JSON.stringify([l.stateDir]), sig, 'R'], { stdio: 'ignore', detached: true });
    await waitForFile(join(sig, 'R-ready'));
    // The publisher has linked the key into place and still holds its temp name.
    writeFileSync(join(sig, 'go-0'), '');
    await new Promise((r) => setTimeout(r, 300));
    writeFileSync(join(sig, 'release'), '');
    const opened = await publisher.done;
    assert.equal(opened.code, 0, opened.stdout + opened.stderr);
    await waitForFile(join(sig, 'R-0'));
    assert.equal(readFileSync(join(sig, 'R-0'), 'utf8'), JSON.parse(opened.stdout).frameKey);
  } finally {
    await stopGroup(publisher.child);
    if (reader) await stopGroup(reader);
  }
});

test('[CORE-015] two processes creating the frame key agree on one whole key', { timeout: 60_000 }, async () => {
  const root = tempDir('frame-keys');
  const sig = tempDir('frame-keys-sig');
  const dirs = range(50).map((i) => join(root, `s${i}`));
  for (const d of dirs) mkdirSync(d, { mode: 0o700 });
  const racers = ['A', 'B'].map((name) => spawn(process.execPath, ['--input-type=module', '-e', FRAME_KEY_RACER, JSON.stringify(dirs), sig, name], { stdio: 'ignore', detached: true }));
  try {
    for (const [i, dir] of dirs.entries()) {
      writeFileSync(join(sig, `go-${i}`), '');
      await waitForFile(join(sig, `A-${i}`));
      await waitForFile(join(sig, `B-${i}`));
      const [a, b] = ['A', 'B'].map((n) => readFileSync(join(sig, `${n}-${i}`), 'utf8'));
      assert.match(a!, /^[0-9a-f]{32}$/, `round ${i}: ${a}`);
      assert.equal(b, a, `round ${i}: both processes return the same key`);
      assert.equal(readFileSync(join(dir, 'frame-key'), 'utf8'), `${a}\n`);
      assert.equal(statSync(join(dir, 'frame-key')).mode & 0o777, 0o600);
    }
  } finally {
    for (const r of racers) await stopGroup(r);
  }
});

test('[CORE-026] two sessions record concurrently from separate processes on a fresh project', { timeout: 60_000 }, async () => {
  const f = fixture();
  const owners = [ownerProcess(), ownerProcess()];
  try {
    const sessions = ['S1', 'S2'];
    const runs = sessions.flatMap((s, k) => range(4).map((i) => startCli(f, ['record', '--session', s, '--runner', 'test', '--hard-limit', '10000', '--owner-pid', String(owners[k]!.pid)], { input: event(`${s}_EVENT_${i}`) })));
    for (const r of await Promise.all(runs.map((c) => c.done))) assert.equal(r.code, 0, r.stdout + r.stderr);
    for (const [k, s] of sessions.entries()) {
      const other = sessions[1 - k]!;
      const l = layout(f.projectRoot, s, f.stateDir);
      const text = readFileSync(l.workingContext, 'utf8');
      for (const i of range(4)) {
        assert.equal(count(text, `${s}_EVENT_${i}\n`), 1);
        assert.equal(count(text, `${other}_EVENT_${i}`), 0);
      }
      assert.equal(JSON.parse(readFileSync(l.head, 'utf8')).rev, 4);
      assert.equal(recall({ ...f, sessionId: s, query: `${other}_EVENT_1` }).total, 0);
    }
  } finally {
    for (const o of owners) await stopGroup(o);
  }
});
