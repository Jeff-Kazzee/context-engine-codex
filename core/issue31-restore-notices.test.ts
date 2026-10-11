import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs, { readFileSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture } from './testing.ts';
import { openSession, confirmRestoreNotices, type Session } from './index.ts';
import { readLog, sha } from './store.ts';
import { armCrash } from './faults.ts';

const core = fileURLToPath(new URL('./', import.meta.url));
for (const mode of ['invalid-sync', 'unmaterialized-append']) {
  test(`issue31: SIGKILL after ${mode} rename retains independently confirmable notices and rejected edits`, () => {
    const f = fixture();
    const opened = openSession({ ...f, sessionId: 'S1', runner: 'test', hardLimit: 10000 });
    assert.equal(opened.status, 'open');
    const s = opened.session;
    s.record([{ role: 'user', text: 'ORIGINAL' }]);
    const wc = s.workingContextPath, state = s.stateDir;
    s.close();
    const child = join(f.projectRoot, 'kill-restore.mjs');
    writeFileSync(child, `import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {openSession} from ${JSON.stringify(join(core, 'index.ts'))};
import {armCrash} from ${JSON.stringify(join(core, 'faults.ts'))};
const opts=${JSON.stringify({ ...f, sessionId: 'S1', runner: 'test', hardLimit: 10000 })};
let opened=openSession(opts); if(opened.status!=='open')throw new Error('open refused');
if(${JSON.stringify(mode)}==='unmaterialized-append'){
 armCrash('before-wc');try{opened.session.record([{role:'assistant',text:'PENDING'}]);}catch{}armCrash(null);
 fs.writeFileSync(opened.session.workingContextPath,'REJECTED_STALE_EDIT');
}else fs.writeFileSync(opened.session.workingContextPath,'');
const native=fs.renameSync;fs.renameSync=((from,to)=>{native(from,to);if(fs.realpathSync(to)===${JSON.stringify(wc)})process.kill(process.pid,'SIGKILL');});syncBuiltinESMExports();
if(${JSON.stringify(mode)}==='unmaterialized-append')openSession(opts);else opened.session.sync();
throw new Error('rename kill not reached');
`);
    const killed = spawnSync(process.execPath, [child], { encoding: 'utf8', timeout: 10000 });
    assert.equal(killed.signal, 'SIGKILL', killed.stderr);
    const before = readFileSync(wc);
    const again = openSession({ ...f, sessionId: 'S1', runner: 'test', hardLimit: 10000 });
    assert.equal(again.status, 'open');
    const result = again.session.sync() as typeof again.session.sync extends () => infer R ? R & { restoreNotices?: Array<{ id: string; text: string }> } : never;
    const expected = mode === 'invalid-sync' ? 1 : 2;
    assert.equal(result.restoreNotices?.length, expected, 'ambiguous predecessor recovery can repeat retention with a distinct attempt ID');
    assert.equal(new Set(result.restoreNotices!.map(n => n.id)).size, expected);
    assert.match(result.restoreNotices![0]!.text, /read.*(?:file|Working Context)/i);
    assert.deepEqual(readFileSync(wc), before, 'notice replay does not rewrite an already materialized file');
    const retained = [...readLog(join(state, 'events.jsonl'))].filter(row => row.type === 'restored');
    assert.equal(retained.length, expected);
    assert.ok(retained.every(row => row.rejected === (mode === 'invalid-sync' ? '' : 'REJECTED_STALE_EDIT')));
    again.session.confirmRestoreNotices(result.restoreNotices!.map(n => n.id));
    assert.equal(again.session.sync().restoreNotices, undefined);
    again.session.close();
  });
}

function committed() {
  const f = fixture(), opts = { ...f, sessionId: 'S1', runner: 'test', hardLimit: 10000, ownerGeneration: '' };
  const opened = openSession(opts); assert.equal(opened.status, 'open');
  opts.ownerGeneration = opened.session.record([{ role: 'user', text: 'ORIGINAL' }]).sessionGeneration!;
  return { f, opts, s: opened.session, log: join(opened.session.stateDir, 'events.jsonl') };
}

function reject(s: Session, bytes = '') {
  writeFileSync(s.workingContextPath, bytes);
  const r = s.sync(); assert.equal(r.restoreNotices?.length, 1);
  return r.restoreNotices![0]!;
}

test('issue31: ambiguous pre-rename retry retains separately identified attempts', () => {
  const t = committed(); writeFileSync(t.s.workingContextPath, '');
  armCrash('wc-tmp');
  try { assert.throws(() => t.s.sync(), /injected crash/); } finally { armCrash(null); }
  const first = [...readLog(t.log)].find(row => row.type === 'restored')!;
  t.s.close();
  const again = openSession(t.opts); assert.equal(again.status, 'open');
  const r = again.session.sync();
  assert.equal(r.restoreNotices?.[0]?.id, (first.notice as { id: string }).id);
  assert.equal(r.restoreNotices?.length, 2);
  assert.notEqual(r.restoreNotices![1]!.id, r.restoreNotices![0]!.id);
  assert.equal([...readLog(t.log)].filter(row => row.type === 'restored').length, 2);
  assert.match(r.restoreNotices![0]!.text, /does not prove.*rename completed/);
  again.session.close();
});

test('issue31: distinct rejections at one revision retain two separately owed IDs', () => {
  const t = committed(), first = reject(t.s);
  writeFileSync(t.s.workingContextPath, ' '.repeat(3));
  const r = t.s.sync(); assert.equal(r.restoreNotices?.length, 2);
  const second = r.restoreNotices![1]!; assert.notEqual(first.id, second.id);
  assert.equal(first.revision, second.revision);
  t.s.confirmRestoreNotices([first.id]);
  assert.deepEqual(t.s.sync().restoreNotices?.map(n => n.id), [second.id]);
  assert.equal([...readLog(t.log)].filter(row => row.type === 'restored').length, 2);
  t.s.close();
});

test('issue31: identical edits after completed restores have distinct IDs and late ack clears only the first', () => {
  const t = committed(), first = reject(t.s);
  writeFileSync(t.s.workingContextPath, '');
  const second = t.s.sync();
  assert.equal(second.restoreNotices?.length, 2);
  assert.notEqual(second.restoreNotices![1]!.id, first.id);
  t.s.confirmRestoreNotices([first.id]);
  assert.deepEqual(t.s.sync().restoreNotices?.map(n => n.id), [second.restoreNotices![1]!.id]);
  t.s.close();
});

test('issue31: unknown ID batch refuses atomically and confirmed IDs are idempotent', () => {
  const t = committed(), notice = reject(t.s), before = readFileSync(t.log);
  assert.throws(() => t.s.confirmRestoreNotices([notice.id, 'f'.repeat(32)]), /unknown.*ID/);
  assert.deepEqual(readFileSync(t.log), before);
  t.s.confirmRestoreNotices([notice.id]);
  const confirmed = readFileSync(t.log);
  t.s.confirmRestoreNotices([notice.id]);
  assert.deepEqual(readFileSync(t.log), confirmed);
  assert.equal(t.s.sync().restoreNotices, undefined);
  t.s.close();
});

test('issue31: stale owner generation refuses before evidence mutation', () => {
  const t = committed(), notice = reject(t.s), before = readFileSync(t.log);
  const stale = (t.opts.ownerGeneration[0] === 'a' ? 'b' : 'a') + t.opts.ownerGeneration.slice(1);
  assert.throws(() => confirmRestoreNotices({ ...t.opts, ownerPid: process.pid, ownerGeneration: stale }, [notice.id]), /different session owner or generation/);
  assert.deepEqual(readFileSync(t.log), before);
  assert.equal(t.s.sync().restoreNotices?.[0]?.id, notice.id);
  t.s.close();
});

test('issue31: external CLI ack cannot be resurrected by an old facade or checkpoint', () => {
  const t = committed(), notice = reject(t.s);
  const ack = spawnSync(process.execPath, [join(core, 'cli.ts'), 'ack-restores', '--session', 'S1', '--project', t.f.projectRoot, '--owner-pid', String(process.pid), '--owner-generation', t.opts.ownerGeneration, '--notice-ids', notice.id], { env: { ...process.env, CONTEXT_ENGINE_STATE_DIR: t.f.stateDir }, encoding: 'utf8', timeout: 10000 });
  assert.equal(ack.status, 0, ack.stderr);
  const r = t.s.record([{ role: 'assistant', text: 'AFTER_EXTERNAL_ACK' }]);
  assert.equal(r.restoreNotices, undefined, 'nonzero-offset refresh honors the external ack before sequence two');
  t.s.close();
  assert.deepEqual(JSON.parse(readFileSync(join(t.s.stateDir, 'recovery.json'), 'utf8')).restoreNotices, []);
  const again = openSession(t.opts); assert.equal(again.status, 'open');
  assert.equal(again.session.sync().restoreNotices, undefined);
  again.session.close();
});

for (const change of ['truncate', 'replace', 'torn']) test(`issue31: a live tail cursor refuses ${change} without repair`, () => {
  const t = committed(); reject(t.s);
  if (change === 'truncate') fs.truncateSync(t.log, 0);
  if (change === 'replace') { const replacement = t.log + '.replacement'; writeFileSync(replacement, readFileSync(t.log), { mode: 0o600 }); fs.renameSync(replacement, t.log); }
  if (change === 'torn') fs.appendFileSync(t.log, '{"partial":');
  const paths = [t.log, t.s.workingContextPath, join(t.s.stateDir, 'HEAD'), join(t.s.stateDir, 'recovery.json')];
  const before = paths.map(p => readFileSync(p));
  assert.throws(() => t.s.sync(), /truncated|replaced|torn/);
  assert.throws(() => t.s.close(), /truncated|replaced|torn/);
  paths.forEach((p, i) => assert.deepEqual(readFileSync(p), before[i]));
});

test('issue31: 65 notices remain durable and bounded batches progress after confirmation', () => {
  const t = committed();
  let r = t.s.sync();
  for (let i = 1; i <= 65; i++) { writeFileSync(t.s.workingContextPath, ' '.repeat(i)); r = t.s.sync(); }
  assert.equal(r.restoreNotices?.length, 64);
  assert.equal(r.restoreNoticesTotal, 65);
  assert.ok(Buffer.byteLength(r.restoreNoticeSummary!) < 600, 'the model-facing batch summary stays bounded');
  const first = r.restoreNotices!.map(n => n.id);
  t.s.close();
  const again = openSession(t.opts); assert.equal(again.status, 'open');
  const resumed = again.session.sync();
  assert.deepEqual(resumed.restoreNotices!.map(n => n.id), first);
  assert.equal(resumed.restoreNoticesTotal, 65);
  again.session.confirmRestoreNotices(first);
  const last = again.session.sync();
  assert.equal(last.restoreNotices?.length, 1);
  assert.equal(last.restoreNoticesTotal, 1);
  assert.ok(!first.includes(last.restoreNotices![0]!.id));
  again.session.confirmRestoreNotices(last.restoreNotices!.map(n => n.id));
  assert.equal(again.session.sync().restoreNotices, undefined);
  assert.equal([...readLog(t.log)].filter(row => row.type === 'restored').length, 65);
  again.session.close();
});

test('issue31: ack-only leaves concurrent editable bytes and invalid ignore untouched', () => {
  const t = committed(), notice = reject(t.s);
  const ignore = join(t.f.projectRoot, '.context-engine', '.gitignore');
  writeFileSync(t.s.workingContextPath, 'CONCURRENT_VALID_EDIT');
  writeFileSync(ignore, 'EXTERNAL_RULE\n');
  const paths = [t.s.workingContextPath, ignore, join(t.s.stateDir, 'HEAD'), join(t.s.stateDir, 'recovery.json')];
  const before = paths.map(p => readFileSync(p));
  confirmRestoreNotices({ ...t.opts, ownerPid: process.pid }, [notice.id]);
  paths.forEach((p, i) => assert.deepEqual(readFileSync(p), before[i]));
  assert.throws(() => confirmRestoreNotices({ ...t.opts, ownerPid: 1 }, [notice.id]), /different session owner/);
  t.s.close();
});

test('issue31: torn and corrupt evidence refuse confirmation without repair', () => {
  for (const tail of ['{"partial":', '{"bad":}\n']) {
    const t = committed(), notice = reject(t.s);
    fs.appendFileSync(t.log, tail);
    const before = readFileSync(t.log), wc = readFileSync(t.s.workingContextPath);
    assert.throws(() => confirmRestoreNotices({ ...t.opts, ownerPid: process.pid }, [notice.id]), /torn|malformed JSON/);
    assert.deepEqual(readFileSync(t.log), before);
    assert.deepEqual(readFileSync(t.s.workingContextPath), wc);
    // Leave this facade abandoned, as for external evidence corruption.
  }
});

test('issue31: missing final covered row refuses ack even with a dense remaining prefix', () => {
  const t = committed(); t.s.record([{ role: 'assistant', text: 'FINAL_EVIDENCE' }]);
  const notice = reject(t.s);
  const rows = readFileSync(t.log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  writeFileSync(t.log, rows.filter(row => row.type !== 'runner-events' || row.events[0].seq !== 2).map(row => JSON.stringify(row)).join('\n') + '\n');
  const paths = [t.log, join(t.s.stateDir, 'HEAD'), t.s.workingContextPath, join(t.s.stateDir, 'recovery.json')];
  const before = paths.map(p => readFileSync(p));
  assert.throws(() => confirmRestoreNotices({ ...t.opts, ownerPid: process.pid }, [notice.id]), /missing covered runner-event sequence evidence/);
  paths.forEach((p, i) => assert.deepEqual(readFileSync(p), before[i]));
});

test('issue31: failed intent append preserves editable file and allows a clean retry', () => {
  const t = committed(), native = fs.writeSync; writeFileSync(t.s.workingContextPath, '');
  fs.writeSync = ((fd: number, data: any, ...args: any[]) => {
    if (fs.readlinkSync(`/proc/self/fd/${fd}`) === t.log && String(data).includes('"type":"restored"')) throw new Error('synthetic intent append failure');
    return (native as any)(fd, data, ...args);
  }) as typeof fs.writeSync; syncBuiltinESMExports();
  try { assert.throws(() => t.s.sync(), /synthetic intent append failure/); }
  finally { fs.writeSync = native; syncBuiltinESMExports(); }
  assert.equal(readFileSync(t.s.workingContextPath, 'utf8'), '');
  assert.equal([...readLog(t.log)].filter(row => row.type === 'restored').length, 0);
  assert.equal(t.s.sync().restoreNotices?.length, 1);
  t.s.close();
});

test('issue31: cache v5 and invalidated v4 reopens retain owed notices', () => {
  const t = committed(), notice = reject(t.s), cache = join(t.s.stateDir, 'recovery.json');
  assert.equal(JSON.parse(readFileSync(cache, 'utf8')).version, 5);
  assert.equal(JSON.parse(readFileSync(cache, 'utf8')).restoreNotices[0].id, notice.id);
  t.s.close();
  for (const version of [5, 4]) {
    if (version === 4) {
      const { checksum: _checksum, ...payload } = JSON.parse(readFileSync(cache, 'utf8'));
      payload.version = 4; delete payload.restoreNotices;
      writeFileSync(cache, JSON.stringify({ ...payload, checksum: sha(JSON.stringify(payload)) }));
    }
    const opened = openSession(t.opts); assert.equal(opened.status, 'open');
    assert.deepEqual(opened.session.sync().restoreNotices?.map(n => n.id), [notice.id]);
    opened.session.close();
    assert.equal(JSON.parse(readFileSync(cache, 'utf8')).version, 5);
  }
});

test('issue31: no-HEAD legacy rejections create no committed restore notice', () => {
  const f = fixture(), opts = { ...f, sessionId: 'S1', runner: 'test', hardLimit: 10000 };
  const opened = openSession(opts); assert.equal(opened.status, 'open');
  writeFileSync(opened.session.workingContextPath, Buffer.from([0xff]));
  assert.throws(() => opened.session.sync(), /no revision exists|no revision to restore/);
  opened.session.close();
  writeFileSync(opened.session.workingContextPath, 'VALID_INITIAL_EDIT');
  const again = openSession(opts); assert.equal(again.status, 'open');
  assert.equal(again.session.sync().restoreNotices, undefined);
  again.session.close();
});

test('issue31: ambiguous confirmation stays owed and requires reopening before more writes', () => {
  const t = committed(), notice = reject(t.s), native = fs.fsyncSync;
  let fail = true;
  fs.fsyncSync = ((fd: number) => {
    if (fail && fs.readlinkSync(`/proc/self/fd/${fd}`) === t.log) { fail = false; throw new Error('synthetic acknowledgment flush failure'); }
    native(fd);
  }); syncBuiltinESMExports();
  try { assert.throws(() => t.s.confirmRestoreNotices([notice.id]), /synthetic acknowledgment flush failure/); }
  finally { fs.fsyncSync = native; syncBuiltinESMExports(); }
  assert.throws(() => t.s.sync(), /append may have persisted/);
  t.s.close();
  const again = openSession(t.opts); assert.equal(again.status, 'open');
  assert.equal(again.session.sync().restoreNotices, undefined, 'the complete persisted confirmation is honored on reopen');
  again.session.close();
});

test('issue31: SIGKILL after CLI stdout before confirmation and adapter defer both replay', () => {
  const t = committed(), wc = t.s.workingContextPath; t.s.close();
  writeFileSync(wc, '');
  const preload = join(t.f.projectRoot, 'kill-output.mjs');
  writeFileSync(preload, `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const native=fs.writeSync;fs.writeSync=((fd,...args)=>{const n=native(fd,...args);if(fd===1)process.kill(process.pid,'SIGKILL');return n;});syncBuiltinESMExports();`);
  const args = [join(core, 'cli.ts'), 'sync', '--session', 'S1', '--project', t.f.projectRoot, '--runner', 'test', '--hard-limit', '10000', '--owner-pid', String(process.pid)];
  const env = { ...process.env, CONTEXT_ENGINE_STATE_DIR: t.f.stateDir };
  const killed = spawnSync(process.execPath, ['--import', preload, ...args], { env, encoding: 'utf8', timeout: 10000 });
  assert.equal(killed.signal, 'SIGKILL', killed.stderr);
  const delivered = JSON.parse(killed.stdout); assert.equal(delivered.restoreNotices.length, 1);
  const deferred = spawnSync(process.execPath, [...args, '--defer-restore-ack'], { env, encoding: 'utf8', timeout: 10000 });
  assert.equal(deferred.status, 0, deferred.stderr);
  assert.equal(JSON.parse(deferred.stdout).restoreNotices[0].id, delivered.restoreNotices[0].id);
  const ack = spawnSync(process.execPath, [args[0]!, 'ack-restores', ...args.slice(2), '--notice-ids', delivered.restoreNotices[0].id, '--owner-generation', delivered.sessionGeneration], { env, encoding: 'utf8', timeout: 10000 });
  assert.equal(ack.status, 0, ack.stderr);
  const reopened = openSession(t.opts); assert.equal(reopened.status, 'open');
  assert.equal(reopened.session.sync().restoreNotices, undefined);
  reopened.session.close();
});
