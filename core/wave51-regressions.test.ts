import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync } from 'node:fs';
import { openSession, recall, show, SHOW_MAX_BYTES } from './index.ts';
import { layout, readLog } from './store.ts';
import { readLock } from './lock.ts';
import { fixture } from './testing.ts';

function committed() {
  const f = fixture();
  const opts = { ...f, sessionId: 'S1', runner: 'regression', hardLimit: 100_000 };
  const opened = openSession(opts);
  assert.equal(opened.status, 'open');
  opened.session.record([{ role: 'user', text: 'COMMITTED_REQUIREMENT' }]);
  opened.session.close();
  return { ...f, opts, paths: layout(f.projectRoot, 'S1', f.stateDir) };
}

for (const kind of ['invalid-json', 'invalid-shape', 'invalid-utf8']) {
  test(`wave51: recovery refuses a complete ${kind} Event Log row and preserves committed bytes`, () => {
    const f = committed();
    const pending = JSON.stringify({ type: 'runner-events', events: [{ seq: 2, event: { role: 'tool', text: 'PENDING_EVENT' } }] });
    let damaged: Buffer;
    if (kind === 'invalid-json') damaged = Buffer.from(pending.slice(0, -1) + '\n');
    else if (kind === 'invalid-shape') damaged = Buffer.from(JSON.stringify({ type: 'runner-events', events: [{ seq: 2, event: { role: 'tool', text: 42 } }] }) + '\n');
    else damaged = Buffer.concat([Buffer.from(pending.slice(0, pending.indexOf('PENDING_EVENT'))), Buffer.from([0xff]), Buffer.from(pending.slice(pending.indexOf('PENDING_EVENT')) + '\n')]);
    appendFileSync(f.paths.events, damaged);
    const before = [f.paths.events, f.paths.head, f.paths.workingContext].map(path => readFileSync(path));
    assert.throws(() => openSession(f.opts), /Event Log.*(?:invalid|malformed)|encoded data/i);
    for (const [index, path] of [f.paths.events, f.paths.head, f.paths.workingContext].entries()) assert.deepEqual(readFileSync(path), before[index]);
    assert.equal(readLock(f.paths.lock), null);
    assert.throws(() => [...readLog(f.paths.events)], /Event Log.*(?:invalid|malformed)|encoded data/i);
    assert.throws(() => recall({ ...f, sessionId: 'S1', query: 'COMMITTED_REQUIREMENT' }), /Event Log.*(?:invalid|malformed)|encoded data/i);
  });
}

test('wave51: a valid complete event before an uncommitted torn tail replays once', () => {
  const f = committed();
  appendFileSync(f.paths.events, JSON.stringify({ type: 'runner-events', events: [{ seq: 2, event: { role: 'tool', text: 'VALID_PENDING_漢_😀' } }] }) + '\n{"type":"runner-events","events":[');
  const opened = openSession(f.opts);
  assert.equal(opened.status, 'open');
  const snapshot = opened.session.sync().workingContextText;
  assert.equal(snapshot.split('COMMITTED_REQUIREMENT').length - 1, 1);
  assert.equal(snapshot.split('VALID_PENDING_漢_😀').length - 1, 1);
  opened.session.close();
  const again = openSession(f.opts);
  assert.equal(again.status, 'open');
  assert.equal(again.session.sync().workingContextText, snapshot);
  again.session.close();
});

for (const lead of ['\udc00', '😀']) {
  test(`wave51: show returns a byte-bounded exact prefix for ${lead.length === 1 ? 'standalone low surrogate' : 'paired surrogate'} input`, () => {
    const f = fixture();
    const opened = openSession({ ...f, sessionId: 'S1', runner: 'regression', hardLimit: 100_000 });
    assert.equal(opened.status, 'open');
    const text = lead + '😀漢'.repeat(10_000);
    opened.session.record([{ role: 'tool', text }]);
    opened.session.close();
    const result = show({ ...f, sessionId: 'S1', id: 'e1' });
    assert.equal(result.truncated, true);
    assert.equal(result.chars, text.length);
    assert.ok(result.text.startsWith(lead));
    assert.equal(result.text, text.slice(0, result.text.length));
    assert.ok(Buffer.byteLength(JSON.stringify({ ok: true, ...result }) + '\n') <= SHOW_MAX_BYTES);
    const last = result.text.charCodeAt(result.text.length - 1);
    assert.ok(last < 0xd800 || last > 0xdbff, 'the prefix must not split a valid surrogate pair');
    const recalled = recall({ ...f, sessionId: 'S1', query: '漢' });
    assert.equal(recalled.hits.length, 1);
    assert.ok(recalled.hits[0]!.snippet.startsWith(lead));
  });
}
