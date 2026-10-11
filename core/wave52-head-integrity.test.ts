import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

for (const mutation of ['missing-witness', 'missing-witness-with-torn-tail', 'missing-marker', 'corrupt-with-torn-tail'] as const) {
  test(`wave52: ${mutation} refuses before recovery mutates state`, () => {
    const f = committed();
    const head = JSON.parse(readFileSync(f.paths.head, 'utf8'));
    if (mutation.startsWith('missing-witness')) {
      const rows = readFileSync(f.paths.events, 'utf8').trim().split('\n').filter(line => JSON.parse(line).type !== 'revision-prepared');
      // HEAD stays valid, so only the boundary check refuses. It must run before the torn tail is cut.
      writeFileSync(f.paths.events, rows.join('\n') + '\n' + (mutation === 'missing-witness' ? '' : '{"unfinished":'));
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

for (const field of ['through', 'prepared'] as const) {
  test(`wave52: committed revision accounting with a conflicting ${field} refuses recovery`, () => {
    const f = committed();
    const head = JSON.parse(readFileSync(f.paths.head, 'utf8'));
    // HEAD and its prepared witness stay valid. Only the final accounting row disagrees.
    const rows = readFileSync(f.paths.events, 'utf8').trim().split('\n').map(line => {
      const row = JSON.parse(line);
      if (row.type === 'revision' && row.rev === head.rev) row[field] = field === 'through' ? head.through + 1 : sha('conflicting prepared identity');
      return JSON.stringify(row);
    });
    writeFileSync(f.paths.events, rows.join('\n') + '\n');
    // The edit can keep the log size, so drop the checkpoint that would skip log validation.
    rmSync(join(f.paths.stateDir, 'recovery.json'), { force: true });
    const paths = [f.paths.head, f.paths.events, f.paths.workingContext];
    const before = paths.map(path => readFileSync(path));
    assert.throws(() => openSession(f.opts), new RegExp(`committed revision accounting ${field === 'through' ? 'through' : 'identity'} conflicts with HEAD`));
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

for (const loss of ['first-row', 'interior-row', 'final-row', 'all-rows', 'batch-interior', 'interior-with-torn-tail'] as const) {
  test(`issue27: missing covered runner evidence ${loss} refuses without changing preserved bytes`, () => {
    const f = fixture();
    const opts = { ...f, sessionId: 'S1', runner: 'issue27', hardLimit: 10_000 };
    const paths = layout(f.projectRoot, 'S1', f.stateDir);
    const opened = openSession(opts);
    assert.equal(opened.status, 'open');
    const events = ['LOST_EVIDENCE', 'INTERIOR_EVIDENCE', 'KEPT_EVIDENCE'].map(text => ({ role: 'user', text }));
    if (loss === 'batch-interior') opened.session.record(events);
    else for (const event of events) opened.session.record([event]);
    opened.session.close();
    const lost = loss === 'first-row' ? 1 : loss === 'final-row' ? 3 : 2;
    const lines = readFileSync(paths.events, 'utf8').trimEnd().split('\n');
    const retained = lines.flatMap(line => {
      const row = JSON.parse(line);
      if (row.type !== 'runner-events') return [line];
      if (loss === 'all-rows') return [];
      if (loss === 'batch-interior') {
        row.events = row.events.filter((event: { seq: number }) => event.seq !== lost);
        return [JSON.stringify(row)];
      }
      return row.events.some((event: { seq: number }) => event.seq === lost) ? [] : [line];
    });
    writeFileSync(paths.events, retained.join('\n') + '\n' + (loss === 'interior-with-torn-tail' ? '{"unfinished":' : ''));
    // The close checkpoint is retained. Changed log metadata must invalidate it.
    const preserved = [paths.events, paths.head, paths.workingContext, join(paths.stateDir, 'recovery.json'),
      ...[1, 2, 3].map(rev => join(paths.revisions, `${rev}.md`)).filter(path => fs.existsSync(path))];
    const before = preserved.map(path => readFileSync(path));
    assert.throws(() => openSession(opts), /covered runner-event sequence evidence/);
    preserved.forEach((path, index) => assert.deepEqual(readFileSync(path), before[index]));
    assert.equal(readLock(paths.lock), null);
  });
}

for (const kind of ['model-edit', 'native-compaction'] as const) {
  for (const lost of [false, true]) {
    test(`issue27: ${kind} recovery with missing covered row=${lost}`, () => {
      const f = fixture();
      const opts = { ...f, sessionId: 'S1', runner: 'issue27', hardLimit: 10_000 };
      const paths = layout(f.projectRoot, 'S1', f.stateDir);
      const opened = openSession(opts);
      assert.equal(opened.status, 'open');
      opened.session.record([{ role: 'user', text: 'LOST_EVIDENCE' }]);
      opened.session.record([{ role: 'tool', text: 'KEPT_EVIDENCE' }]);
      if (kind === 'model-edit') {
        writeFileSync(paths.workingContext, 'MODEL_EDIT_CONTROL');
        opened.session.sync();
      } else opened.session.nativeCompaction([{ role: 'user', text: 'COMPACTION_CONTROL' }]);
      opened.session.close();
      if (!lost) priorRecoveryCheckpoint(join(paths.stateDir, 'recovery.json'));
      const expectedText = readFileSync(paths.workingContext, 'utf8');
      const rows = readFileSync(paths.events, 'utf8').trimEnd().split('\n');
      if (lost) writeFileSync(paths.events, rows.filter(line => {
        const row = JSON.parse(line);
        return row.type !== 'runner-events' || !row.events.some((event: { seq: number }) => event.seq === 1);
      }).join('\n') + '\n');
      const preserved = [paths.events, paths.head, paths.workingContext, join(paths.stateDir, 'recovery.json')];
      const before = preserved.map(path => readFileSync(path));
      if (lost) {
        assert.throws(() => openSession(opts), /covered runner-event sequence evidence/);
        preserved.forEach((path, index) => assert.deepEqual(readFileSync(path), before[index]));
        assert.equal(readLock(paths.lock), null);
      } else {
        const again = openSession(opts);
        assert.equal(again.status, 'open');
        assert.equal(again.session.sync().workingContextText, expectedText);
        again.session.close();
      }
    });
  }
}

test('issue27: a missing pending sequence refuses before replay publishes another prepared HEAD', (t) => {
  const f = committed();
  appendFileSync(f.paths.events, JSON.stringify({ type: 'runner-events', events: [
    { seq: 2, event: { role: 'tool', text: 'PENDING_BEFORE_LOSS' } },
    { seq: 4, event: { role: 'tool', text: 'PENDING_AFTER_LOSS' } },
  ] }) + '\n');
  const paths = [f.paths.events, f.paths.head, f.paths.workingContext, join(f.paths.stateDir, 'recovery.json')];
  const before = paths.map(path => readFileSync(path));
  let error: unknown;
  let returned: ReturnType<typeof openSession> | undefined;
  try { returned = openSession(f.opts); } catch (cause) { error = cause; }
  t.diagnostic(JSON.stringify({ beforeThrough: JSON.parse(before[1]!.toString()).through,
    afterThrough: JSON.parse(readFileSync(f.paths.head, 'utf8')).through,
    returned: returned?.status ?? 'refused' }));
  if (returned?.status === 'open') returned.session.close();
  assert.match(String(error), /covered runner-event sequence evidence/);
  paths.forEach((path, index) => assert.deepEqual(readFileSync(path), before[index]));
  assert.equal(readLock(f.paths.lock), null);
});

function priorRecoveryCheckpoint(path: string, log?: string): void {
  const { checksum: _checksum, ...payload } = JSON.parse(readFileSync(path, 'utf8'));
  payload.version = 3;
  if (log) {
    const stat = fs.statSync(log, { bigint: true });
    payload.log = { dev: String(stat.dev), ino: String(stat.ino), size: String(stat.size),
      mtime: String(stat.mtimeNs), ctime: String(stat.ctimeNs) };
  }
  writeFileSync(path, JSON.stringify({ ...payload, checksum: sha(JSON.stringify(payload)) }));
}

test('issue27: a prior weaker checkpoint cannot authorize missing sequence evidence', () => {
  const f = committed();
  const opened = openSession(f.opts);
  assert.equal(opened.status, 'open');
  opened.session.record([{ role: 'tool', text: 'KEPT_EVIDENCE' }]);
  opened.session.close();
  const rows = readFileSync(f.paths.events, 'utf8').trimEnd().split('\n');
  writeFileSync(f.paths.events, rows.filter(line => {
    const row = JSON.parse(line);
    return row.type !== 'runner-events' || !row.events.some((event: { seq: number }) => event.seq === 1);
  }).join('\n') + '\n');
  const cache = join(f.paths.stateDir, 'recovery.json');
  // The old validator could accept this loss and save a metadata-matching v3 cache.
  priorRecoveryCheckpoint(cache, f.paths.events);
  const paths = [f.paths.events, f.paths.head, f.paths.workingContext, cache];
  const before = paths.map(path => readFileSync(path));
  assert.throws(() => openSession(f.opts), /covered runner-event sequence evidence/);
  paths.forEach((path, index) => assert.deepEqual(readFileSync(path), before[index]));
  assert.equal(readLock(f.paths.lock), null);
});

test('issue27: a valid prior checkpoint upgrades after recovery and the current checkpoint reopens', () => {
  const f = committed();
  const cache = join(f.paths.stateDir, 'recovery.json');
  priorRecoveryCheckpoint(cache);
  const expected = readFileSync(f.paths.workingContext, 'utf8');
  const opened = openSession(f.opts);
  assert.equal(opened.status, 'open');
  assert.equal(opened.session.sync().workingContextText, expected);
  opened.session.close();
  assert.equal(JSON.parse(readFileSync(cache, 'utf8')).version, 5);
  const again = openSession(f.opts);
  assert.equal(again.status, 'open');
  assert.equal(again.session.sync().workingContextText, expected);
  again.session.close();
});

test('issue27: first-commit pending loss refuses before creating a prepared HEAD', (t) => {
  const f = fixture();
  const opts = { ...f, sessionId: 'S1', runner: 'issue27', hardLimit: 10_000 };
  const paths = layout(f.projectRoot, 'S1', f.stateDir);
  const first = openSession(opts);
  assert.equal(first.status, 'open');
  first.session.close();
  appendFileSync(paths.events, JSON.stringify({ type: 'runner-events', events: [
    { seq: 1, event: { role: 'user', text: 'FIRST_PENDING' } },
    { seq: 3, event: { role: 'tool', text: 'AFTER_MISSING_PENDING' } },
  ] }) + '\n');
  const preserved = [paths.events, paths.head, paths.workingContext, join(paths.stateDir, 'recovery.json')];
  const bytes = (path: string) => fs.existsSync(path) ? readFileSync(path) : null;
  const before = preserved.map(bytes);
  let error: unknown;
  let returned: ReturnType<typeof openSession> | undefined;
  try { returned = openSession(opts); } catch (cause) { error = cause; }
  t.diagnostic(JSON.stringify({ beforeHead: null, afterThrough: fs.existsSync(paths.head) ? JSON.parse(readFileSync(paths.head, 'utf8')).through : null,
    returned: returned?.status ?? 'refused' }));
  if (returned?.status === 'open') returned.session.close();
  assert.match(String(error), /covered runner-event sequence evidence/);
  preserved.forEach((path, index) => assert.deepEqual(bytes(path), before[index]));
  assert.equal(readLock(paths.lock), null);
});

for (const transition of ['unchanged', 'pending-replay', 'model-edit', 'all-rows'] as const) {
  test(`issue27: legacy runner loss refuses before ${transition} recovery changes evidence`, () => {
    const f = committed();
    const opened = openSession(f.opts);
    assert.equal(opened.status, 'open');
    opened.session.record([{ role: 'tool', text: 'KEPT_LEGACY_EVIDENCE' }]);
    opened.session.close();
    legacy(f, transition === 'all-rows');
    const rows = readFileSync(f.paths.events, 'utf8').trimEnd().split('\n');
    writeFileSync(f.paths.events, rows.filter(line => {
      const row = JSON.parse(line);
      return row.type !== 'runner-events' || (transition !== 'all-rows' && !row.events.some((event: { seq: number }) => event.seq === 1));
    }).join('\n') + '\n');
    if (transition === 'pending-replay') appendFileSync(f.paths.events, JSON.stringify({ type: 'runner-events',
      events: [{ seq: 3, event: { role: 'tool', text: 'NEW_PENDING_LEGACY_EVENT' } }] }) + '\n');
    if (transition === 'model-edit') writeFileSync(f.paths.workingContext, 'NEW_LEGACY_MODEL_EDIT');
    const orphan = join(f.paths.revisions, '99.md'), temporary = join(f.paths.stateDir, 'issue27-evidence.tmp');
    writeFileSync(orphan, 'ORPHAN_REVISION_EVIDENCE');
    writeFileSync(temporary, 'TEMPORARY_EVIDENCE');
    const paths = [f.paths.events, f.paths.head, f.paths.workingContext, join(f.paths.stateDir, 'recovery.json'),
      join(f.paths.revisions, '1.md'), join(f.paths.revisions, '2.md'), orphan, temporary];
    const before = paths.map(path => readFileSync(path));
    assert.throws(() => openSession(f.opts), /covered runner-event sequence evidence/);
    paths.forEach((path, index) => assert.deepEqual(readFileSync(path), before[index]));
    assert.equal(readLock(f.paths.lock), null);
  });
}
