import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectSession, openSession, readWorkingContext, recall, RECALL_GUIDANCE, RECALL_MAX_BYTES, show, SHOW_MAX_BYTES, type Session } from './index.ts';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fixture, tempDir } from './testing.ts';

type Fixture = ReturnType<typeof fixture>;

for(const flush of ['file','directory'])test('wave26: ambiguous '+flush+' accounting flush preserves recall/show/read evidence',()=>{
 const f=fixture(),session=open(f);session.record([{role:'tool',text:'ACCOUNTING_EVIDENCE'}]);session.close();
 const log=join(inspectSession({...f,sessionId:'S1'}).stateDir,'events.jsonl'),native=fs.fsyncSync;
 fs.fsyncSync=((fd:number)=>{const path=fs.realpathSync(`/proc/self/fd/${fd}`);if(path===(flush==='file'?log:dirname(log)))throw Object.assign(new Error('synthetic post-write flush failure'),{code:'ENOSPC'});native(fd);}) as typeof fs.fsyncSync;syncBuiltinESMExports();
 try{
  const r=recall({...f,sessionId:'S1',query:'ACCOUNTING_EVIDENCE'});assert.equal(r.accounting,'skipped');assert.match(r.note!,/could not be confirmed/);assert.equal(r.hits[0]!.id,'e1');
  const sh=show({...f,sessionId:'S1',id:'e1'});assert.equal(sh.accounting,'skipped');assert.match(sh.note!,/could not be confirmed/);assert.match(sh.text,/ACCOUNTING_EVIDENCE/);
  const rd=readWorkingContext({...f,sessionId:'S1'});assert.equal(rd.accounting,'skipped');assert.match(rd.text,/ACCOUNTING_EVIDENCE/);
 }finally{fs.fsyncSync=native;syncBuiltinESMExports();}
});

function open(f: Fixture, sessionId = 'S1'): Session {
  const r = openSession({ ...f, sessionId, runner: 'test', hardLimit: 100_000 });
  assert.equal(r.status, 'open');
  return r.session;
}

test('recall finds dropped evidence in the Event Log and returns it with an event id', () => {
  const f = fixture();
  const s = open(f);
  s.record([
    { role: 'user', text: 'Task: fix the date parser.' },
    { role: 'tool', text: '$ npm test\n3 failed: parseDate("2024-02-30") returned Invalid Date' },
  ]);

  const r = recall({ ...f, sessionId: 'S1', query: 'parseDate' });
  assert.equal(r.query, 'parseDate');
  assert.equal(r.total, 1);
  assert.equal(r.truncated, false);
  assert.equal(r.hits.length, 1);
  assert.equal(r.hits[0]!.id, 'e2');
  assert.equal(r.hits[0]!.role, 'tool');
  assert.match(r.hits[0]!.snippet, /3 failed: parseDate\("2024-02-30"\) returned Invalid Date/);
});

test('a query of several words matches events containing all of them, in any order and case', () => {
  const f = fixture();
  open(f).record([
    { role: 'tool', text: 'parseDate returned Invalid Date for Feb 30' },
    { role: 'tool', text: 'parseDate passed' },
    { role: 'tool', text: 'Invalid config' },
  ]);
  assert.deepEqual(
    recall({ ...f, sessionId: 'S1', query: 'invalid  PARSEDATE' }).hits.map((h) => h.id),
    ['e1'],
  );
});

const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v));

test('recall never returns more than RECALL_MAX_BYTES and says when matches were left out', () => {
  const f = fixture();
  const s = open(f);
  const huge = `${'x'.repeat(50_000)} NEEDLE ${'y'.repeat(50_000)}`;
  s.record(Array.from({ length: 200 }, (_, i) => ({ role: 'tool', text: `run ${i}: ${huge} ünïcödé ✓ "quoted"\n` })));

  const r = recall({ ...f, sessionId: 'S1', query: 'needle' });
  assert.ok(bytes(r) <= RECALL_MAX_BYTES, `${bytes(r)} bytes`);
  assert.equal(r.total, 200);
  assert.ok(r.hits.length > 0 && r.hits.length < 200);
  assert.equal(r.truncated, true);
  for (const h of r.hits) assert.match(h.snippet, /NEEDLE/);
  assert.equal(RECALL_MAX_BYTES, 4096);
});

test('newest matches come first, so a superseded value is not what survives truncation', () => {
  const f = fixture();
  const s = open(f);
  s.record([{ role: 'tool', text: 'PORT=3000' }]);
  s.record([{ role: 'tool', text: 'PORT=4000' }]);
  assert.deepEqual(
    recall({ ...f, sessionId: 'S1', query: 'PORT' }).hits.map((h) => h.id),
    ['e2', 'e1'],
  );
});

test('a short event comes back whole and the result is not marked truncated', () => {
  const f = fixture();
  open(f).record([{ role: 'tool', text: 'only one match here' }]);
  const r = recall({ ...f, sessionId: 'S1', query: 'match' });
  assert.equal(r.truncated, false);
  assert.equal(r.hits[0]!.snippet, 'only one match here');
});

test('recall cannot read another session or another project', () => {
  const f = fixture();
  const other = { ...f, projectRoot: tempDir('project') };
  open(f).record([{ role: 'tool', text: 'SECRET-S1' }]);
  open(f, 'S2').record([{ role: 'tool', text: 'SECRET-S2' }]);
  open(other).record([{ role: 'tool', text: 'SECRET-OTHER-PROJECT' }]);

  assert.deepEqual(
    recall({ ...f, sessionId: 'S1', query: 'SECRET' }).hits.map((h) => h.snippet),
    ['SECRET-S1'],
  );
  assert.deepEqual(
    recall({ ...other, sessionId: 'S1', query: 'SECRET' }).hits.map((h) => h.snippet),
    ['SECRET-OTHER-PROJECT'],
  );
  for (const sessionId of ['../S2', 'S1/../S2', '../../x']) {
    assert.throws(() => recall({ ...f, sessionId, query: 'SECRET' }), /invalid session id/);
  }
});

test('recall on a session with no Event Log fails and creates nothing', () => {
  const f = fixture();
  assert.throws(() => recall({ ...f, sessionId: 'S1', query: 'x' }), /no session S1 in this project/);
  assert.equal(existsSync(f.stateDir), false);
  assert.deepEqual(readdirSync(f.projectRoot), []);
});

const logEntries = (s: Session) =>
  readFileSync(join(s.stateDir, 'events.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Record<string, unknown>);

test('each recall is counted in the Event Log with its query, and is not itself a recall hit', () => {
  const f = fixture();
  const s = open(f);
  s.record([{ role: 'tool', text: 'build failed: missing semicolon' }]);
  recall({ ...f, sessionId: 'S1', query: 'semicolon' });
  recall({ ...f, sessionId: 'S1', query: 'nothing like this' });

  const recalls = logEntries(s).filter((e) => e.type === 'recall');
  assert.deepEqual(
    recalls.map(({ at, ...e }) => e),
    [
      { type: 'recall', query: 'semicolon', total: 1, returned: 1, truncated: false },
      { type: 'recall', query: 'nothing like this', total: 0, returned: 0, truncated: false },
    ],
  );
  assert.equal(recall({ ...f, sessionId: 'S1', query: 'semicolon' }).total, 1, 'logged queries are not searched');
  assert.equal(s.sync().revision, 1, 'recall leaves the session usable');
});

test('a rejected Working Context edit kept in the Event Log can be recalled', () => {
  const f = fixture();
  const s = open(f);
  s.record([{ role: 'user', text: 'Task.' }]);
  writeFileSync(s.workingContextPath, 'x'.repeat(200_000) + ' NOTE-I-LOST');
  assert.equal(s.sync().receipt?.kind, 'restored');

  const r = recall({ ...f, sessionId: 'S1', query: 'note-i-lost' });
  assert.deepEqual(
    r.hits.map((h) => ({ id: h.id, role: h.role })),
    [{ id: 'r1', role: 'rejected-edit' }],
  );
  assert.match(r.hits[0]!.snippet, /NOTE-I-LOST$/);
});

test('show returns one event whole, by the id recall gave', () => {
  const f = fixture();
  const s = open(f);
  s.record([{ role: 'user', text: 'Task.' }, { role: 'tool', text: 'exit code 2\nstack: at parse (date.ts:14)' }]);
  const id = recall({ ...f, sessionId: 'S1', query: 'exit code' }).hits[0]!.id;
  assert.deepEqual(show({ ...f, sessionId: 'S1', id }), {
    id: 'e2',
    role: 'tool',
    text: 'exit code 2\nstack: at parse (date.ts:14)',
    chars: 40,
    truncated: false,
  });
});

test('show is bounded by SHOW_MAX_BYTES and says when the text was cut', () => {
  const f = fixture();
  const s = open(f);
  const big = `START ${'é"\n'.repeat(40_000)} END`;
  s.record([{ role: 'tool', text: big }]);
  const r = show({ ...f, sessionId: 'S1', id: 'e1' });
  assert.ok(bytes(r) <= SHOW_MAX_BYTES, `${bytes(r)} bytes`);
  assert.equal(SHOW_MAX_BYTES, 16_384);
  assert.equal(r.truncated, true);
  assert.equal(r.chars, big.length);
  assert.ok(r.text.length > 1000 && big.startsWith(r.text));
});

test('show refuses ids that are not in this session', () => {
  const f = fixture();
  open(f).record([{ role: 'tool', text: 'one' }]);
  open(f, 'S2').record([{ role: 'tool', text: 'a' }, { role: 'tool', text: 'b' }]);
  for (const id of ['e2', 'e0', 'r1', 'x', '']) {
    assert.throws(() => show({ ...f, sessionId: 'S1', id }), /no event/);
  }
});

test('RECALL_GUIDANCE is one line naming the recall and show commands, for adapters to include', () => {
  assert.equal(RECALL_GUIDANCE.includes('\n'), false);
  assert.match(RECALL_GUIDANCE, /context-engine recall --session <session-id> /);
  assert.match(RECALL_GUIDANCE, /context-engine show --session <session-id> <event-id>/);
  assert.ok(RECALL_GUIDANCE.length < 400);
});

test('an empty or oversized query is refused', () => {
  const f = fixture();
  open(f).record([{ role: 'tool', text: 'text' }]);
  assert.throws(() => recall({ ...f, sessionId: 'S1', query: '  ' }), /query/);
  assert.throws(() => recall({ ...f, sessionId: 'S1', query: 'q'.repeat(1000) }), /query/);
});

for (const code of ['EACCES', 'ENOSPC', 'EDQUOT']) test(`when accounting fails with ${code}, recall and show still return evidence`, () => {
  const f = fixture();
  const s = open(f);
  s.record([{ role: 'tool', text: 'parseDate("2024-02-30") returned Invalid Date' }]);
  s.close();
  const log = join(inspectSession({ ...f, sessionId: 'S1' }).stateDir, 'events.jsonl');
  const before = readFileSync(log, 'utf8');
  const nativeOpen = fs.openSync;
  fs.openSync = ((path: any, flags: any, ...args: any[]) => {
    if (fs.realpathSync(dirname(String(path))) === dirname(log) && String(path).endsWith('/events.jsonl') && (flags === 'a' || typeof flags === 'number' && !!(flags & fs.constants.O_APPEND))) throw Object.assign(new Error('synthetic append denied'), { code });
    return (nativeOpen as any)(path, flags, ...args);
  }) as typeof fs.openSync;
  syncBuiltinESMExports();
  try {
    const r = recall({ ...f, sessionId: 'S1', query: 'parseDate' });
    assert.equal(r.hits.length, 1);
    assert.equal(r.hits[0]!.id, 'e1');
    assert.equal(r.accounting, 'skipped');
    assert.match(r.note!, /Not counted/);
    const sh = show({ ...f, sessionId: 'S1', id: 'e1' });
    assert.match(sh.text, /Invalid Date/);
    assert.equal(sh.accounting, 'skipped');
    const rd = readWorkingContext({ ...f, sessionId: 'S1' });
    assert.match(rd.text, /Invalid Date/);
    assert.equal(rd.accounting, 'skipped');
  } finally {
    fs.openSync = nativeOpen;
    syncBuiltinESMExports();
  }
  assert.equal(readFileSync(log, 'utf8'), before, 'nothing appended');
  assert.equal(recall({ ...f, sessionId: 'S1', query: 'parseDate' }).accounting, undefined, 'writable again: counted, no flag');
});
