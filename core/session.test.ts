import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openSession, type Session } from './index.ts';
import { armCrash, InjectedCrash } from './faults.ts';
import { fixture } from './testing.ts';

function open(f: { stateDir: string; projectRoot: string }, sessionId = 'S1', hardLimit = 10_000): Session {
  const r = openSession({ ...f, sessionId, runner: 'test', hardLimit });
  assert.equal(r.status, 'open');
  return r.session;
}

test('happy path: runner turns are recorded, a model edit is committed as the next revision', () => {
  const f = fixture();
  const s = open(f);
  assert.deepEqual(s.sync(), { revision: 0, turns: [], chars: 0, workingContextText: '' });

  const r1 = s.record([
    { role: 'user', text: 'Task: fix the failing date parser.' },
    { role: 'assistant', text: 'Running the tests.' },
    { role: 'tool', text: '$ npm test\n3 failed: parseDate("2024-02-30") ...(long output)' },
  ]);
  assert.equal(r1.revision, 1);
  assert.deepEqual(r1.turns, [
    { role: 'user', text: 'Task: fix the failing date parser.' },
    { role: 'assistant', text: 'Running the tests.' },
    { role: 'user', text: '$ npm test\n3 failed: parseDate("2024-02-30") ...(long output)' },
  ]);
  assert.equal(r1.receipt, undefined);

  const file = readFileSync(s.workingContextPath, 'utf8');
  assert.match(file, /^\[\[CTX_TURN 3 role=tool\]\]$/m);

  // The model rewrites the tool turn into a short note with its ordinary Edit tool.
  const edited = file.replace(/\[\[CTX_TURN 3 role=tool\]\][\s\S]*$/, '[[CTX_TURN 3 role=notes]]\nVERIFIED: parseDate fails on Feb 30.\n');
  writeFileSync(s.workingContextPath, edited);

  const r2 = s.sync();
  assert.equal(r2.revision, 2);
  assert.deepEqual(r2.turns.at(-1), { role: 'user', text: 'VERIFIED: parseDate fails on Feb 30.' });
  assert.equal(r2.chars, edited.length);
  assert.equal(r2.receipt?.kind, 'committed');
  assert.equal(r2.receipt?.revision, 2);

  const r3 = s.sync();
  assert.equal(r3.revision, 2);
  assert.equal(r3.receipt, undefined);
  s.close();
});

const eventsOf = (s: Session) =>
  readFileSync(`${s.stateDir}/events.jsonl`, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Record<string, unknown>);

test('edit vs append: a runner append never overwrites an uncommitted model edit', () => {
  const f = fixture();
  const s = open(f);
  s.record([{ role: 'user', text: 'Task: fix the parser.' }, { role: 'tool', text: 'LONG TOOL OUTPUT' }]);
  const edited = readFileSync(s.workingContextPath, 'utf8').replace('LONG TOOL OUTPUT', 'NOTE: tests fail on Feb 30.');
  writeFileSync(s.workingContextPath, edited);

  const r = s.record([{ role: 'assistant', text: 'Patching parseDate.' }]);
  assert.equal(r.revision, 3, 'model edit committed as 2, then the append as 3');
  assert.equal(r.receipt?.kind, 'committed');
  const file = readFileSync(s.workingContextPath, 'utf8');
  assert.ok(file.includes('NOTE: tests fail on Feb 30.'));
  assert.ok(!file.includes('LONG TOOL OUTPUT'));
  assert.ok(file.endsWith('[[CTX_TURN 3 role=assistant]]\nPatching parseDate.\n'));
  assert.deepEqual(r.turns.at(-1), { role: 'assistant', text: 'Patching parseDate.' });
});

test('safe failure: empty, missing, huge and non-UTF-8 files are restored from HEAD with a receipt', async (t) => {
  const f = fixture();
  const s = open(f, 'S1', 200);
  s.record([{ role: 'user', text: 'Task: fix the parser.' }]);
  const good = readFileSync(s.workingContextPath, 'utf8');
  const huge = good + 'x'.repeat(500);
  const notUtf8 = Buffer.from([0x5b, 0xff, 0xfe, 0x0a]);

  const cases: Array<[string, () => void]> = [
    ['empty', () => writeFileSync(s.workingContextPath, '  \n')],
    ['missing', () => rmSync(s.workingContextPath)],
    ['over-hard-limit', () => writeFileSync(s.workingContextPath, huge)],
    ['not-utf8', () => writeFileSync(s.workingContextPath, notUtf8)],
  ];
  for (const [reason, breakIt] of cases) {
    await t.test(reason, () => {
      breakIt();
      const r = s.sync();
      assert.equal(r.revision, 1);
      assert.equal(r.receipt?.kind, 'restored');
      assert.equal(r.receipt?.kind === 'restored' && r.receipt.reason, reason);
      assert.equal(readFileSync(s.workingContextPath, 'utf8'), good);
      assert.equal(eventsOf(s).filter((e) => e.type === 'restored').at(-1)?.reason, reason);
    });
  }
  const restored = eventsOf(s).filter((e) => e.type === 'restored');
  assert.equal(restored.find((e) => e.reason === 'over-hard-limit')?.rejected, huge, 'rejected text kept verbatim');
  assert.equal(restored.find((e) => e.reason === 'not-utf8')?.rejectedBase64, notUtf8.toString('base64'));
});

test('receipts never contain model-authored text', () => {
  const f = fixture();
  const s = open(f, 'S1', 300);
  const secret = 'MODEL-SENTINEL-7f3a';
  s.record([{ role: 'user', text: 'Task.' }]);
  const receipts = [];
  writeFileSync(s.workingContextPath, `[[CTX_TURN 1 role=user]]\nTask. ${secret}\n`);
  receipts.push(s.sync().receipt);
  writeFileSync(s.workingContextPath, `${secret}\n`.repeat(100));
  receipts.push(s.sync().receipt);
  writeFileSync(s.workingContextPath, '   ');
  receipts.push(s.sync().receipt);
  for (const r of receipts) {
    assert.ok(r);
    assert.ok(!JSON.stringify(r).includes(secret), JSON.stringify(r));
    assert.ok(!JSON.stringify(r).includes('Task.'), JSON.stringify(r));
  }
});

test('receipts show the revision and an approximate token count (chars / 4)', () => {
  const f = fixture();
  const s = open(f);
  s.record([{ role: 'user', text: 'Task.' }]);
  writeFileSync(s.workingContextPath, `${'a'.repeat(998)}\n`);
  const committed = s.sync().receipt;
  assert.equal(committed?.revision, 2);
  assert.equal(committed?.chars, 999);
  assert.equal(committed?.approxTokens, 250);
  assert.match(committed!.text, /revision 2\b.*~250 tokens \(approx/);

  writeFileSync(s.workingContextPath, '');
  const restored = s.sync().receipt;
  assert.equal(restored?.kind, 'restored');
  assert.equal(restored?.approxTokens, 250);
  assert.match(restored!.text, /Revision 2\b.*~250 tokens \(approx/);
});

test('a file written before any revision is committed as revision 1; an unusable one is logged and preserved for repair', () => {
  const f = fixture();
  const s = open(f, 'S1', 50);
  writeFileSync(s.workingContextPath, 'y'.repeat(80));
  assert.throws(() => s.sync(), /file preserved/);
  assert.equal(readFileSync(s.workingContextPath, 'utf8'), 'y'.repeat(80));
  assert.equal(eventsOf(s).find((e) => e.type === 'restored')?.rejected, 'y'.repeat(80));
  writeFileSync(s.workingContextPath, '');
  assert.equal(s.record([{ role: 'user', text: 'Task.' }]).revision, 1);

  const s2 = open(f, 'S2', 50);
  writeFileSync(s2.workingContextPath, 'my own notes\n');
  assert.deepEqual(s2.sync(), { revision: 1, turns: [{ role: 'user', text: 'my own notes' }], chars: 13, workingContextText: 'my own notes\n' });
});

test('resume continues from the latest committed revision: deleted content does not come back', () => {
  const f = fixture();
  const s = open(f);
  s.record([{ role: 'user', text: 'Task.' }, { role: 'tool', text: 'DELETED-SENTINEL' }]);
  writeFileSync(s.workingContextPath, '[[CTX_TURN 1 role=user]]\nTask.\n');
  s.sync();
  s.close();

  const resumed = open(f);
  const r = resumed.record([{ role: 'assistant', text: 'Continuing.' }]);
  assert.equal(r.revision, 3);
  assert.ok(!JSON.stringify(r.turns).includes('DELETED-SENTINEL'));
  assert.ok(!readFileSync(resumed.workingContextPath, 'utf8').includes('DELETED-SENTINEL'));
});

test('the frame key is random per session, kept in the private state directory, and the same on every reopen', () => {
  const f = fixture();
  const a = open(f);
  assert.match(a.frameKey, /^[0-9a-f]{32}$/);
  a.close();
  assert.equal(open(f).frameKey, a.frameKey, 'a resumed process recognises the frames built before it');
  assert.notEqual(open(f, 'S2').frameKey, a.frameKey, 'another session has another key');
});

// Review round 2, finding 4: an empty or partial frame-key file (a crash during a non-atomic
// create) was returned as the key forever, and an empty key makes the Claude adapter stand aside.
for (const [label, content] of [['empty', ''], ['partial', '012345'], ['partial, newline-terminated', '0123456789abcdef\n']] as const) {
  test(`an interrupted create's frame-key file (${label}) is replaced by a whole key, which then stands`, () => {
    const f = fixture();
    const a = open(f);
    a.close();
    writeFileSync(join(a.stateDir, 'frame-key'), content);
    const b = open(f);
    assert.match(b.frameKey, /^[0-9a-f]{32}$/);
    assert.equal(readFileSync(join(a.stateDir, 'frame-key'), 'utf8'), `${b.frameKey}\n`, 'published whole');
    b.close();
    assert.equal(open(f).frameKey, b.frameKey, 'the recovered key is the one every later open sees');
  });
}

test('a crash while the frame key is being created never leaves a torn key: the next open creates a whole one', () => {
  const f = fixture();
  armCrash('frame-key-tmp');
  try {
    assert.throws(() => open(f), InjectedCrash);
  } finally {
    armCrash(null);
  }
  const s = open(f);
  assert.match(s.frameKey, /^[0-9a-f]{32}$/);
  assert.equal(readFileSync(join(s.stateDir, 'frame-key'), 'utf8'), `${s.frameKey}\n`);
  assert.deepEqual(readdirSync(s.stateDir).filter((n) => n.endsWith('.tmp')), [], 'the crashed temp file is removed by recovery');
});
