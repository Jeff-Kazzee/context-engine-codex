import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { openSession } from './index.ts';
import { layout, sha } from './store.ts';
import { join } from 'node:path';
import { readLock } from './lock.ts';
import { fixture } from './testing.ts';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

function committed() {
  const f = fixture();
  const opts = { ...f, sessionId: 'S1', runner: 'head-integrity', hardLimit: 10_000 };
  const opened = openSession(opts);
  assert.equal(opened.status, 'open');
  opened.session.record([{ role: 'user', text: 'COMMITTED_REQUIREMENT' }]);
  opened.session.close();
  return { ...f, opts, paths: layout(f.projectRoot, 'S1', f.stateDir) };
}

function legacy(f: ReturnType<typeof committed>, missingAccounting = false) {
  const head = JSON.parse(readFileSync(f.paths.head, 'utf8'));
  delete head.prepared;
  writeFileSync(f.paths.head, JSON.stringify(head));
  const rows = readFileSync(f.paths.events, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  writeFileSync(f.paths.events, rows.filter(row => row.type !== 'revision-prepared' && !(missingAccounting && row.type === 'revision')).map(row => {
    if (row.type === 'revision') { delete row.through; delete row.prepared; }
    return JSON.stringify(row);
  }).join('\n') + '\n');
}

for (const through of [0, 2]) {
  test(`wave52: ordinary legacy revision accounting rejects corrupted through=${through}`, () => {
    const f = committed();
    legacy(f);
    pending(f.paths.events);
    const head = JSON.parse(readFileSync(f.paths.head, 'utf8'));
    head.through = through;
    writeFileSync(f.paths.head, JSON.stringify(head));
    assert.throws(() => openSession(f.opts), /legacy HEAD through/);
  });
}

for (const missingAccounting of [false, true]) {
  test(`wave52: legacy compatibility preserves pending replay with missing accounting=${missingAccounting}`, () => {
    const f = committed();
    legacy(f, missingAccounting);
    pending(f.paths.events);
    const opened = openSession(f.opts);
    assert.equal(opened.status, 'open');
    const result = opened.session.sync();
    assert.equal(result.workingContextText.split('COMMITTED_REQUIREMENT').length - 1, 1);
    assert.equal(result.workingContextText.split('PENDING_REQUIREMENT').length - 1, 1);
    assert.equal(typeof JSON.parse(readFileSync(f.paths.head, 'utf8')).prepared, 'string');
    opened.session.close();
  });
}

for (const mutation of ['missing-witness', 'missing-marker', 'corrupt-with-torn-tail'] as const) {
  test(`wave52: ${mutation} refuses before recovery mutates state`, () => {
    const f = committed();
    const head = JSON.parse(readFileSync(f.paths.head, 'utf8'));
    if (mutation === 'missing-witness') {
      const rows = readFileSync(f.paths.events, 'utf8').trim().split('\n').filter(line => JSON.parse(line).type !== 'revision-prepared');
      writeFileSync(f.paths.events, rows.join('\n') + '\n');
    } else {
      if (mutation === 'missing-marker') delete head.prepared;
      else { head.through = 0; appendFileSync(f.paths.events, '{"unfinished":'); }
      writeFileSync(f.paths.head, JSON.stringify(head));
    }
    const paths = [f.paths.head, f.paths.events, f.paths.workingContext];
    const before = paths.map(path => readFileSync(path));
    assert.throws(() => openSession(f.opts), /HEAD|accounting/);
    paths.forEach((path, index) => assert.deepEqual(readFileSync(path), before[index]));
    assert.equal(readLock(f.paths.lock), null);
  });
}

test('wave52: an orphan preparation does not replace the selected commit boundary', () => {
  const f = committed();
  const head = JSON.parse(readFileSync(f.paths.head, 'utf8'));
  appendFileSync(f.paths.events, JSON.stringify({ type: 'revision-prepared', ...head, through: 0, prepared: '0'.repeat(64) }) + '\n');
  pending(f.paths.events);
  const opened = openSession(f.opts);
  assert.equal(opened.status, 'open');
  assert.equal(opened.session.sync().workingContextText.split('COMMITTED_REQUIREMENT').length - 1, 1);
  opened.session.close();
});

test('wave52: a conflicting duplicate of the selected prepared identity refuses', () => {
  const f = committed();
  const head = JSON.parse(readFileSync(f.paths.head, 'utf8'));
  appendFileSync(f.paths.events, JSON.stringify({ type: 'revision-prepared', ...head, through: 0 }) + '\n');
  assert.throws(() => openSession(f.opts), /prepared revision accounting conflicts/);
});

test('wave52: ambiguous prepared-record flush requires reopen and replays once', () => {
  const f = committed();
  const opened = openSession(f.opts);
  assert.equal(opened.status, 'open');
  const native = fs.fsyncSync;
  let failed = false;
  fs.fsyncSync = ((fd: number) => {
    if (!failed && fs.realpathSync(`/proc/self/fd/${fd}`) === f.paths.events) {
      const last = JSON.parse(readFileSync(f.paths.events, 'utf8').trim().split('\n').at(-1)!);
      if (last.type === 'revision-prepared' && last.rev === 2) {
        failed = true;
        throw Object.assign(new Error('fixture prepared flush failure'), { code: 'EIO' });
      }
    }
    native(fd);
  }) as typeof fs.fsyncSync;
  syncBuiltinESMExports();
  try { assert.throws(() => opened.session.record([{ role: 'tool', text: 'PENDING_REQUIREMENT' }]), /fixture prepared flush/); }
  finally { fs.fsyncSync = native; syncBuiltinESMExports(); }
  assert.equal(failed, true);
  assert.throws(() => opened.session.sync(), /close and reopen/);
  opened.session.close();
  const again = openSession(f.opts);
  assert.equal(again.status, 'open');
  assert.equal(again.session.sync().workingContextText.split('PENDING_REQUIREMENT').length - 1, 1);
  again.session.close();
});

test('wave52: legacy model-edit accounting does not consume a pending write-ahead event', () => {
  const f = committed();
  legacy(f);
  pending(f.paths.events);
  const previous = JSON.parse(readFileSync(f.paths.head, 'utf8'));
  const edited = 'EDITED_REQUIREMENT';
  writeFileSync(join(f.paths.revisions, '2.md'), edited);
  writeFileSync(f.paths.workingContext, edited);
  writeFileSync(f.paths.head, JSON.stringify({ rev: 2, sha: sha(edited), parent: previous.sha, through: 1, kind: 'model-edit', materialized: true }));
  appendFileSync(f.paths.events, JSON.stringify({ type: 'revision', rev: 2, kind: 'model-edit', sha: sha(edited), chars: edited.length }) + '\n');
  const again = openSession(f.opts);
  assert.equal(again.status, 'open');
  const text = again.session.sync().workingContextText;
  assert.equal(text.split('EDITED_REQUIREMENT').length - 1, 1);
  assert.equal(text.split('PENDING_REQUIREMENT').length - 1, 1);
  again.session.close();
});

function pending(path: string) {
  appendFileSync(path, JSON.stringify({ type: 'runner-events', events: [{ seq: 2, event: { role: 'tool', text: 'PENDING_REQUIREMENT' } }] }) + '\n');
}

for (const through of [0, 2]) {
  test(`wave52: corrupted HEAD through=${through} refuses without duplicating or suppressing events`, () => {
    const f = committed();
    pending(f.paths.events);
    const head = JSON.parse(readFileSync(f.paths.head, 'utf8'));
    assert.equal(head.through, 1);
    head.through = through;
    writeFileSync(f.paths.head, JSON.stringify(head));
    const paths = [f.paths.events, f.paths.head, f.paths.workingContext];
    const before = paths.map(path => readFileSync(path));
    assert.throws(() => openSession(f.opts), /through|accounting|sequence|HEAD/i);
    paths.forEach((path, index) => assert.deepEqual(readFileSync(path), before[index]));
    assert.equal(readLock(f.paths.lock), null);
  });
}

for (const missingAccounting of [false, true]) {
  test(`wave52: valid HEAD replays pending events once with missing accounting=${missingAccounting}`, () => {
    const f = committed();
    if (missingAccounting) {
      const retained = readFileSync(f.paths.events, 'utf8').split('\n').filter(line => {
        if (!line) return false;
        const item = JSON.parse(line);
        return !(item.type === 'revision' && item.rev === 1);
      });
      writeFileSync(f.paths.events, retained.join('\n') + '\n');
    }
    pending(f.paths.events);
    const opened = openSession(f.opts);
    assert.equal(opened.status, 'open');
    const text = opened.session.sync().workingContextText;
    assert.equal(text.split('COMMITTED_REQUIREMENT').length - 1, 1);
    assert.equal(text.split('PENDING_REQUIREMENT').length - 1, 1);
    opened.session.close();
    const again = openSession(f.opts);
    assert.equal(again.status, 'open');
    assert.equal(again.session.sync().workingContextText, text);
    again.session.close();
  });
}
