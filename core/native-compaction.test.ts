// The Compaction-only fallback's core half (issue #22): when the Working Context alone is over its
// budget at a compaction, the runner's own summarizer compacts instead, and its result becomes the
// next Revision (kind `native-compaction`), so the next turn starts small instead of thrashing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { COMPACTION_ONLY_FALLBACK, inspectSession, openSession, recall, type Session } from './index.ts';
import { armCrash, InjectedCrash } from './faults.ts';
import { fixture } from './testing.ts';

type F = ReturnType<typeof fixture>;

function open(f: F, budgetTokens = 1000, hardLimit = 1_000_000): Session {
  const r = openSession({ ...f, sessionId: 'S1', runner: 'test', hardLimit, budgetTokens });
  assert.equal(r.status, 'open');
  return r.session;
}

const log = (s: Session) =>
  readFileSync(join(s.stateDir, 'events.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Record<string, any>);

const SUMMARY = [{ role: 'user', text: 'Summary: the task is to fix the parser; FACT 7 = olive-lynx-6510.' }];

test('the label is exactly the one the issue fixes', () => {
  assert.equal(COMPACTION_ONLY_FALLBACK.label, 'Compaction-only (fallback: Working Context over budget)');
});

test('a native compaction replaces the Working Context with the runner summary, as the next revision of its own kind', () => {
  const f = fixture();
  const s = open(f);
  const before = s.record([{ role: 'user', text: 'Task: fix the parser.' }, { role: 'tool', text: 'x'.repeat(6000) }]);
  assert.equal(before.budget!.overBudget, true);

  const r = s.nativeCompaction(SUMMARY);
  assert.equal(r.revision, before.revision + 1);
  assert.deepEqual(r.turns, [{ role: 'user', text: SUMMARY[0]!.text }]);
  assert.equal(readFileSync(s.workingContextPath, 'utf8'), `[[CTX_TURN 1 role=user]]\n${SUMMARY[0]!.text}\n`);
  assert.equal(r.budget!.overBudget, false, 'the next turn starts inside the budget');

  const entries = log(s);
  assert.equal(entries.filter((e) => e.type === 'revision').at(-1)!.kind, 'native-compaction');
  const delivery = entries.find((e) => e.type === 'delivery');
  assert.deepEqual(
    { mode: delivery!.mode, reason: delivery!.reason, rev: delivery!.rev, budgetTokens: delivery!.budgetTokens },
    { mode: COMPACTION_ONLY_FALLBACK.label, reason: 'over-budget', rev: r.revision, budgetTokens: 1000 },
  );
  assert.ok(delivery!.approxTokensBefore > 1000);
  s.close();
});

test('the summary is kept verbatim in the Event Log and can be recalled; so is everything before it', () => {
  const f = fixture();
  const s = open(f);
  s.record([{ role: 'tool', text: `NEEDLE 042: amber-otter-1234 ${'x'.repeat(6000)}` }]);
  s.nativeCompaction(SUMMARY);
  s.close();
  assert.equal(recall({ ...f, sessionId: 'S1', query: 'olive-lynx-6510' }).total, 1);
  assert.equal(recall({ ...f, sessionId: 'S1', query: 'amber-otter-1234' }).total, 1);
});

test('status names the latest revision kind, so a Compaction-only turn is visible after the fact', () => {
  const f = fixture();
  const s = open(f);
  s.record([{ role: 'tool', text: 'x'.repeat(6000) }]);
  assert.equal(inspectSession({ ...f, sessionId: 'S1' }).revisionKind, 'runner-append');
  s.nativeCompaction(SUMMARY);
  assert.equal(inspectSession({ ...f, sessionId: 'S1' }).revisionKind, 'native-compaction');
  s.close();
});

test('an uncommitted model edit is committed first, then replaced (it stays in its own revision)', () => {
  const f = fixture();
  const s = open(f);
  s.record([{ role: 'tool', text: 'x'.repeat(6000) }]);
  writeFileSync(s.workingContextPath, `[[CTX_TURN 1 role=user]]\nMY NOTE ${'y'.repeat(5000)}\n`);
  const r = s.nativeCompaction(SUMMARY);
  const kinds = log(s).filter((e) => e.type === 'revision').map((e) => e.kind);
  assert.deepEqual(kinds.slice(-2), ['model-edit', 'native-compaction']);
  assert.match(readFileSync(join(s.stateDir, 'revisions', `${r.revision - 1}.md`), 'utf8'), /MY NOTE/);
  s.close();
});

test('a crash after the summary is logged replays it as a replacement on reopen, never as an append', () => {
  const f = fixture();
  const s = open(f);
  s.record([{ role: 'tool', text: `OLD ${'x'.repeat(6000)}` }]);
  armCrash('after-log');
  try {
    assert.throws(() => s.nativeCompaction(SUMMARY), InjectedCrash);
  } finally {
    armCrash(null);
  }
  const again = open(f);
  const r = again.sync();
  assert.deepEqual(r.turns, [{ role: 'user', text: SUMMARY[0]!.text }]);
  assert.doesNotMatch(readFileSync(again.workingContextPath, 'utf8'), /OLD/);
  assert.equal(log(again).filter((e) => e.type === 'revision').at(-1)!.kind, 'native-compaction');
  again.close();
});

test('a revision the runner appended over the hard limit is not reported as a rejected edit on every sync', () => {
  const f = fixture();
  const s = open(f, 1000, 5000);
  s.record([{ role: 'tool', text: 'x'.repeat(6000) }]);
  const r = s.sync();
  assert.equal(r.receipt, undefined, 'the file is the committed revision; nothing was edited, so nothing is restored');
  assert.equal(log(s).filter((e) => e.type === 'restored').length, 0);
  s.close();
});
