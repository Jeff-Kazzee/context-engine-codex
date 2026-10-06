// Crash walkthroughs. Crashes are injected through the core's private fault seam; everything else
// goes through the public interface. After a crash the Session object is abandoned, as if the
// adapter process died, and the session is reopened.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openSession, type Session } from './index.ts';
import { armCrash, InjectedCrash, type CrashPoint } from './faults.ts';
import { fixture } from './testing.ts';

type Fixture = ReturnType<typeof fixture>;

function open(f: Fixture): Session {
  const r = openSession({ ...f, sessionId: 'S1', runner: 'test', hardLimit: 10_000 });
  assert.equal(r.status, 'open');
  return r.session;
}

function crash(point: CrashPoint, fn: () => unknown): void {
  armCrash(point);
  try {
    assert.throws(fn, InjectedCrash);
  } finally {
    armCrash(null);
  }
}

/** Invariants that must hold after any recovery + sync. */
function assertConsistent(s: Session): void {
  const r = s.sync();
  const revs = readdirSync(join(s.stateDir, 'revisions'));
  assert.deepEqual(
    revs.map((f) => Number(f.replace('.md', ''))).sort((a, b) => a - b),
    Array.from({ length: r.revision }, (_, i) => i + 1),
    'exactly revisions 1..HEAD exist (no orphans, no temp files)',
  );
  assert.equal(readFileSync(s.workingContextPath, 'utf8'), readFileSync(join(s.stateDir, 'revisions', `${r.revision}.md`), 'utf8'));
  assert.ok(!readdirSync(s.stateDir).some((f) => f.endsWith('.tmp')));
  assert.ok(!readdirSync(join(s.workingContextPath, '..')).some((f) => f.endsWith('.tmp')));
  for (const line of readFileSync(join(s.stateDir, 'events.jsonl'), 'utf8').trim().split('\n')) JSON.parse(line);
}

const count = (text: string, needle: string) => text.split(needle).length - 1;

test('crash mid-commit: the orphan snapshot is discarded and the edit is committed on restart', () => {
  const f = fixture();
  const s = open(f);
  s.record([{ role: 'user', text: 'Task: fix the parser.' }, { role: 'tool', text: 'LONG OUTPUT' }]);
  writeFileSync(s.workingContextPath, '[[CTX_TURN 1 role=user]]\nTask: fix the parser.\n\n[[CTX_TURN 2 role=notes]]\nNOTE\n');
  crash('before-head', () => s.sync());

  const again = open(f);
  const r = again.sync();
  assert.equal(r.revision, 2);
  assert.equal(r.receipt?.kind, 'committed', 'the receipt from recovery is delivered on the next sync');
  assert.deepEqual(r.turns, [{ role: 'user', text: 'Task: fix the parser.\n\nNOTE' }]);
  assertConsistent(again);
});

for (const point of ['snapshot-tmp', 'head-tmp'] as const) {
  test(`crash mid-commit at ${point}: temp debris is removed and HEAD stands`, () => {
    const f = fixture();
    const s = open(f);
    s.record([{ role: 'user', text: 'one' }]);
    crash(point, () => s.record([{ role: 'assistant', text: 'two' }]));

    const again = open(f);
    const r = again.sync();
    assert.equal(r.revision, 2, 'the logged event is replayed into revision 2');
    assert.deepEqual(r.turns, [
      { role: 'user', text: 'one' },
      { role: 'assistant', text: 'two' },
    ]);
    assertConsistent(again);
  });
}

test('torn write of the Working Context: the live file is rebuilt from HEAD, no turn is duplicated', () => {
  const f = fixture();
  const s = open(f);
  s.record([{ role: 'user', text: 'one' }]);
  crash('wc-tmp', () => s.record([{ role: 'tool', text: 'SENTINEL-TWO' }]));
  assert.ok(!readFileSync(s.workingContextPath, 'utf8').includes('SENTINEL-TWO'), 'the live file is still the old one');

  const again = open(f);
  assert.equal(again.sync().revision, 2);
  assert.equal(count(readFileSync(again.workingContextPath, 'utf8'), 'SENTINEL-TWO'), 1);
  assertConsistent(again);
});

for (const point of ['after-log', 'before-head', 'before-wc'] as const) {
  test(`write-ahead replay after a crash at ${point}: the logged turn is applied exactly once`, () => {
    const f = fixture();
    const s = open(f);
    s.record([{ role: 'user', text: 'one' }]);
    crash(point, () => s.record([{ role: 'tool', text: 'SENTINEL-TWO' }, { role: 'assistant', text: 'three' }]));

    const again = open(f);
    const r = again.sync();
    assert.equal(r.revision, 2);
    assert.equal(count(readFileSync(again.workingContextPath, 'utf8'), 'SENTINEL-TWO'), 1);
    assert.deepEqual(r.turns.at(-1), { role: 'assistant', text: 'three' });
    // Later records continue the sequence without re-applying anything.
    const r2 = again.record([{ role: 'user', text: 'four' }]);
    assert.equal(r2.revision, 3);
    assert.equal(count(readFileSync(again.workingContextPath, 'utf8'), 'SENTINEL-TWO'), 1);
    assertConsistent(again);
  });
}

test('torn Event Log line: the half-written batch is cut off and never applied', () => {
  const f = fixture();
  const s = open(f);
  s.record([{ role: 'user', text: 'one' }]);
  crash('log-torn', () => s.record([{ role: 'tool', text: 'SENTINEL-TORN' }]));

  const again = open(f);
  assert.equal(again.sync().revision, 1);
  assert.ok(!readFileSync(again.workingContextPath, 'utf8').includes('SENTINEL-TORN'));
  assert.equal(again.record([{ role: 'assistant', text: 'two' }]).revision, 2);
  assertConsistent(again);
});

test('a torn Event Log line survives a lock takeover by another owner', async () => {
  const f = fixture();
  const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' });
  const r = openSession({ ...f, sessionId: 'S1', runner: 'test', hardLimit: 10_000, ownerPid: holder.pid! });
  assert.equal(r.status, 'open');
  r.session.record([{ role: 'user', text: 'one' }]);
  crash('log-torn', () => r.session.record([{ role: 'tool', text: 'SENTINEL-TORN' }]));
  holder.kill('SIGKILL');
  await once(holder, 'exit');

  const again = open(f);
  assert.equal(again.record([{ role: 'assistant', text: 'two' }]).revision, 2);
  assert.ok(!readFileSync(again.workingContextPath, 'utf8').includes('SENTINEL-TORN'));
  assertConsistent(again);
});

test('a model edit made while the adapter was dead is committed on restart, then pending events are replayed', () => {
  const f = fixture();
  const s = open(f);
  s.record([{ role: 'user', text: 'one' }, { role: 'tool', text: 'BIG' }]);
  crash('after-log', () => s.record([{ role: 'assistant', text: 'three' }]));
  writeFileSync(s.workingContextPath, '[[CTX_TURN 1 role=user]]\none\n\n[[CTX_TURN 2 role=notes]]\nsmall\n');

  const again = open(f);
  const r = again.sync();
  assert.equal(r.revision, 3, 'edit committed as 2, replayed event as 3');
  const file = readFileSync(again.workingContextPath, 'utf8');
  assert.ok(file.includes('small') && !file.includes('BIG') && file.includes('three'));
  assertConsistent(again);
});

test("recovery removes only the core's own temp files: an agent's offloaded *.tmp files beside the Working Context survive", () => {
  const f = fixture();
  const s = open(f);
  s.record([{ role: 'user', text: 'Task: collect the results.' }]);
  const dir = join(s.workingContextPath, '..');
  writeFileSync(join(dir, 'results.tmp'), 'EVIDENCE: 42 passing');
  writeFileSync(join(dir, 'context.md.notes.tmp'), 'MORE EVIDENCE');
  // A crash mid-write leaves the core's own temp file behind as well.
  crash('wc-tmp', () => s.record([{ role: 'tool', text: 'SENTINEL-TWO' }]));
  const again = open(f);
  assert.equal(readFileSync(join(dir, 'results.tmp'), 'utf8'), 'EVIDENCE: 42 passing');
  assert.equal(readFileSync(join(dir, 'context.md.notes.tmp'), 'utf8'), 'MORE EVIDENCE');
  assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith('.tmp')).sort(), ['context.md.notes.tmp', 'results.tmp'], 'the crash debris is gone');
  again.sync();
});
