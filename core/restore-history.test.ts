import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { fixture } from './testing.ts';
import { appendLog, sha } from './store.ts';
import { keepRestoreIntent, restoreNoticeState, confirmRestoreNoticeIds } from './restore-notices.ts';
import { armCrash } from './faults.ts';

function history(count: number) {
  const f = fixture(), log = join(f.stateDir, 'events.jsonl'), pending = new Map();
  mkdirSync(f.stateDir, { mode: 0o700 });
  const ids: string[] = [];
  let first;
  for (let i = 0; i < count; i++) {
    const { notice } = keepRestoreIntent(log, pending, { rev: 1, sha: sha('HEAD') }, 'empty', 0, { rejected: '' });
    first ??= notice;
    ids.push(notice.id);
    appendLog(log, { type: 'restore-notice-return-confirmed', noticeIds: [notice.id] });
    pending.delete(notice.id);
  }
  return { log, ids, first: first! };
}

test('confirmed restore history retains no historical notice objects or confirmed ID set', () => {
  const { log } = history(128), before = readFileSync(log);
  const state = restoreNoticeState(log, true);
  assert.equal(state.notices.size, 0, 'only pending notice bodies remain in memory');
  assert.equal(state.confirmed.size, 0, 'historical confirmation IDs belong to the bounded derived lookup');
  assert.deepEqual(readFileSync(log), before);
});

test('confirmed restore history keeps atomic unknown-ID refusal and old confirmation idempotence', () => {
  const { log, ids } = history(16), before = readFileSync(log);
  confirmRestoreNoticeIds(log, [ids[0]!]);
  assert.deepEqual(readFileSync(log), before);
  assert.throws(() => confirmRestoreNoticeIds(log, [ids[0]!, 'f'.repeat(32)]), /unknown restore notice ID/);
  assert.deepEqual(readFileSync(log), before);
});

test('cold recovery still refuses conflicting reuse of a confirmed restore ID', () => {
  const { log, first } = history(16), rejected = { rejected: 'CONFLICT' };
  appendLog(log, { type: 'restored', rev: 1, reason: 'empty', ...rejected, notice: { ...first, rejectedSha256: sha(JSON.stringify(rejected)) } });
  const before = readFileSync(log);
  assert.throws(() => restoreNoticeState(log, true), /conflicting durable restore notice identity/);
  assert.deepEqual(readFileSync(log), before);
});

for (const damage of ['missing-head', 'missing-shard', 'changed-shard']) test(`restore lookup rebuilds after ${damage} without losing pending or confirmed evidence`, () => {
  const { log, ids } = history(16), pending = new Map();
  const notice = keepRestoreIntent(log, pending, { rev: 1, sha: sha('HEAD') }, 'empty', 0, { rejected: '' }).notice;
  assert.equal(restoreNoticeState(log).notices.get(notice.id)?.id, notice.id);
  const dir = join(log, '..');
  if (damage === 'missing-head') fs.unlinkSync(join(dir, 'restore-index.json'));
  else {
    const head = JSON.parse(readFileSync(join(dir, 'restore-index.json'), 'utf8'));
    const name = Object.keys(head.shards).find(n => head.shards[n].bytes > 2)!;
    const shard = join(dir, `restore-index-${name}.json`);
    if (damage === 'missing-shard') fs.unlinkSync(shard); else writeFileSync(shard, '[]');
  }
  assert.deepEqual([...restoreNoticeState(log).notices.keys()], [notice.id]);
  const before = readFileSync(log);
  confirmRestoreNoticeIds(log, [ids[0]!]);
  assert.deepEqual(readFileSync(log), before);
});

test('an interrupted restore lookup rebuild leaves source evidence recoverable', () => {
  const { log } = history(16), pending = new Map();
  const notice = keepRestoreIntent(log, pending, { rev: 1, sha: sha('HEAD') }, 'empty', 0, { rejected: '' }).notice;
  const before = readFileSync(log);
  armCrash('operation-index-tmp');
  try { assert.throws(() => restoreNoticeState(log), /injected crash/); } finally { armCrash(null); }
  assert.deepEqual(readFileSync(log), before);
  assert.deepEqual([...restoreNoticeState(log).notices.keys()], [notice.id]);
});

test('linked restore lookup head refuses without reading or changing its outside target', () => {
  const { log } = history(1), outside = join(log, '..', 'outside');
  writeFileSync(outside, 'UNOWNED_TARGET', { mode: 0o600 });
  fs.symlinkSync(outside, join(log, '..', 'restore-index.json'));
  const before = readFileSync(log);
  assert.throws(() => restoreNoticeState(log), /link|regular|unsafe|private|refus/i);
  assert.equal(readFileSync(outside, 'utf8'), 'UNOWNED_TARGET');
  assert.deepEqual(readFileSync(log), before);
});

test('a requested confirmed-ID lookup adds no second full historical payload scan', () => {
  const { log, ids } = history(16);
  appendLog(log, { type: 'retained-test-payload', text: 'x'.repeat(1024 * 1024) });
  restoreNoticeState(log, true);
  let bytes = 0;
  const native = fs.readSync;
  fs.readSync = ((fd: number, ...args: unknown[]) => {
    const n = Reflect.apply(native, fs, [fd, ...args]);
    if (fs.readlinkSync(`/proc/self/fd/${fd}`) === log) bytes += n;
    return n;
  }) as typeof fs.readSync;
  syncBuiltinESMExports();
  try { confirmRestoreNoticeIds(log, [ids[0]!]); } finally { fs.readSync = native; syncBuiltinESMExports(); }
  assert.ok(bytes <= readFileSync(log).length + 2 * 65536, `one mandatory integrity scan plus two row lookups, read ${bytes} bytes`);
});
