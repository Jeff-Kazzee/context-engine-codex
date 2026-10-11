import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openSession } from './index.ts';
import { fixture, tempDir } from './testing.ts';
import { layout } from './store.ts';
import { acquireLock, holderFor, readLock, releaseLock } from './lock.ts';

for (const ownerPid of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
  test(`wave52: invalid ownerPid ${ownerPid} refuses before creating state`, () => {
    const f = fixture();
    assert.throws(() => openSession({ ...f, sessionId: 'S1', runner: 'ownership', hardLimit: 10000, ownerPid }), /ownerPid/);
    assert.equal(existsSync(f.stateDir), false);
    assert.equal(existsSync(join(f.projectRoot, '.context-engine')), false);
  });
}

test('wave52: closing either reentrant facade invalidates its sibling before same-owner reacquisition', () => {
  const f = fixture();
  const opts = { ...f, sessionId: 'S1', runner: 'ownership', hardLimit: 10000 };
  const a = openSession(opts), b = openSession(opts);
  assert.equal(a.status, 'open');
  assert.equal(b.status, 'open');
  a.session.record([{ role: 'user', text: 'OLD_GENERATION' }]);
  a.session.close();
  const c = openSession(opts);
  assert.equal(c.status, 'open');
  c.session.record([{ role: 'user', text: 'NEW_GENERATION' }]);
  const paths = layout(f.projectRoot, 'S1', f.stateDir);
  const files = [paths.events, paths.head, paths.lock, paths.workingContext];
  const before = files.map(path => readFileSync(path));
  for (const action of [() => b.session.sync(), () => b.session.record([{ role: 'tool', text: 'STALE_WRITE' }]), () => b.session.nativeCompaction([{ role: 'user', text: 'STALE_REPLACE' }]), () => b.session.confirmReceiptReturn(), () => b.session.close()]) {
    assert.throws(action, /closed/);
    files.forEach((path, index) => assert.deepEqual(readFileSync(path), before[index]));
  }
  assert.equal(c.session.sync().workingContextText.includes('NEW_GENERATION'), true);
  c.session.close();
});

test('wave52: reentrant facades remain usable while their shared lock is held', () => {
  const f = fixture();
  const opts = { ...f, sessionId: 'S1', runner: 'ownership', hardLimit: 10000, ownerPid: process.pid };
  const a = openSession(opts), b = openSession(opts);
  assert.equal(a.status, 'open');
  assert.equal(b.status, 'open');
  a.session.record([{ role: 'user', text: 'FIRST_HANDLE' }]);
  b.session.record([{ role: 'tool', text: 'SECOND_HANDLE' }]);
  assert.match(a.session.sync().workingContextText, /FIRST_HANDLE[\s\S]*SECOND_HANDLE/);
  b.session.close();
  assert.throws(() => a.session.close(), /closed/);
});

test('wave52: a reentrant holder releases the current lock lifetime but not a later one', () => {
  const path = join(tempDir('reentrant-release'), 'session.lock');
  const first = holderFor(process.pid, 'ownership', 1000), again = holderFor(process.pid, 'ownership', 1000);
  assert.equal(acquireLock(path, first).status, 'acquired');
  assert.deepEqual(acquireLock(path, again), { status: 'acquired', takeoverFrom: null, reused: true });
  releaseLock(path, again);
  assert.equal(existsSync(path), false);
  const later = holderFor(process.pid, 'ownership', 1000);
  assert.equal(acquireLock(path, later).status, 'acquired');
  releaseLock(path, again);
  releaseLock(path, first);
  const current = readLock(path);
  assert.ok(current && current !== 'unreadable');
  assert.equal(current.generation, later.generation);
  releaseLock(path, later);
  assert.equal(existsSync(path), false);
});
