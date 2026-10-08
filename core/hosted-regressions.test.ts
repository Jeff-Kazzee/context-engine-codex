import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { cite, inspectSession, openSession, readWorkingContext, recall, show, setParticipation, participation } from './index.ts';
import { atomicWrite, resolveStateRoot } from './store.ts';
import { fixture, tempDir } from './testing.ts';
import { acquireLock as acquire, holderFor, releaseLock } from './lock.ts';

test('short lock and log writes are complete before publication and retain a live owner', () => {
  const f = fixture(), native = fs.writeSync;
  fs.writeSync = ((fd: number, bytes: Uint8Array, offset: number, length: number) => native(fd, bytes, offset, Math.min(3, length))) as typeof fs.writeSync;
  syncBuiltinESMExports();
  try {
    const opened = openSession({ ...f, sessionId: 'S1', runner: 'test', hardLimit: 10000 }); assert.equal(opened.status, 'open'); const s = opened.session;
    assert.equal(acquire(join(s.stateDir, 'lock'), holderFor(process.pid + 100000, 'contender', 10000)).status, 'refused');
    s.record([{ role: 'user', text: 'SYNTHETIC_COMPLETE_LOG_EVENT' }]); s.close();
    assert.match(show({ ...f, sessionId: 'S1', id: 'e1' }).text, /SYNTHETIC_COMPLETE_LOG_EVENT/);
  } finally { fs.writeSync = native; syncBuiltinESMExports(); }
});

test('zero-progress lock writes never publish or leave candidates', () => {
  const root = tempDir('lock-zero'), path = join(root, 'lock'), native = fs.writeSync;
  fs.writeSync = (() => 0) as typeof fs.writeSync; syncBuiltinESMExports();
  try { assert.throws(() => acquire(path, holderFor(process.pid, 'test', 10000)), /no progress/); }
  finally { fs.writeSync = native; syncBuiltinESMExports(); }
  assert.deepEqual(fs.readdirSync(root), []);
});

test('a failed partial log append requires reopening and cannot swallow the next successful entry', () => {
  const f = fixture(), opened = openSession({ ...f, sessionId: 'S1', runner: 'test', hardLimit: 10000 }); assert.equal(opened.status, 'open'); const s = opened.session;
  s.record([{ role: 'user', text: 'BASELINE' }]); const before = s.sync().revision, log = join(s.stateDir, 'events.jsonl'), native = fs.writeSync; let partial = false;
  fs.writeSync = ((fd: number, bytes: Uint8Array, offset: number, length: number) => {
    if (fs.realpathSync(`/proc/self/fd/${fd}`) === log) { if (partial) return 0; partial = true; return native(fd, bytes, offset, 3); }
    return native(fd, bytes, offset, length);
  }) as typeof fs.writeSync; syncBuiltinESMExports();
  try { assert.throws(() => s.record([{ role: 'tool', text: 'FAILED_APPEND' }]), /incomplete Event Log/); assert.throws(()=>s.sync(),/close and reopen/); }
  finally { fs.writeSync = native; syncBuiltinESMExports(); }
  assert.throws(()=>s.record([{role:'tool',text:'SUCCESS_AFTER_FAILURE'}]),/close and reopen/);s.close();
  const reopened=openSession({...f,sessionId:'S1',runner:'test',hardLimit:10000});assert.equal(reopened.status,'open');assert.equal(reopened.session.sync().revision,before);
  reopened.session.record([{ role: 'tool', text: 'SUCCESS_AFTER_FAILURE' }]); reopened.session.close();
  assert.equal(recall({ ...f, sessionId: 'S1', query: 'SUCCESS_AFTER_FAILURE' }).total, 1);
  assert.equal(recall({ ...f, sessionId: 'S1', query: 'FAILED_APPEND' }).total, 0);
});

test('close logging failure releases the live session lock and closes the facade', () => {
  const f = fixture(), opened = openSession({ ...f, sessionId: 'S1', runner: 'test', hardLimit: 10000 }); assert.equal(opened.status, 'open'); const s = opened.session, log = join(s.stateDir, 'events.jsonl'), native = fs.openSync;
  fs.openSync = ((path: any, flags: any, ...args: any[]) => { if (fs.realpathSync(dirname(String(path))) === dirname(log) && String(path).endsWith('/events.jsonl') && (flags === 'a' || typeof flags === 'number' && !!(flags & fs.constants.O_APPEND))) throw Object.assign(new Error('synthetic storage full'), { code: 'ENOSPC' }); return (native as any)(path, flags, ...args); }) as typeof fs.openSync; syncBuiltinESMExports();
  try { assert.throws(() => s.close(), /synthetic storage full/); }
  finally { fs.openSync = native; syncBuiltinESMExports(); }
  assert.equal(inspectSession({ ...f, sessionId: 'S1' }).lock, null); assert.throws(() => s.sync(), /closed/);
});

test('an oversized sparse Working Context is restored without reading or logging its bytes', () => {
  const f = fixture(), opened = openSession({ ...f, sessionId: 'S1', runner: 'test', hardLimit: 10000 }); assert.equal(opened.status, 'open'); const s = opened.session;
  s.record([{ role: 'user', text: 'SMALL_GOOD_REVISION' }]); fs.truncateSync(s.workingContextPath, 1024 * 1024 * 1024);
  const result = s.sync(); assert.equal(result.receipt?.kind, 'restored'); assert.match(result.receipt?.text ?? '', /oversized bytes were not read/);
  assert.match(result.workingContextText, /SMALL_GOOD_REVISION/); assert.ok(fs.statSync(join(s.stateDir, 'events.jsonl')).size < 10000); s.close();
});

test('an oversized first file has a visible metadata-only rejection without a revision', () => {
  const f = fixture(), path = join(f.projectRoot, '.context-engine/S1/context.md'); fs.mkdirSync(dirname(path), { recursive: true }); fs.writeFileSync(path, ''); fs.truncateSync(path, 1024 * 1024 * 1024);
  assert.throws(() => openSession({ ...f, sessionId: 'S1', runner: 'test', hardLimit: 10000 }), /not read or copied.*preserved/);
  const l = layout(f.projectRoot, 'S1', f.stateDir);
  assert.equal(fs.statSync(path).size, 1024 * 1024 * 1024); assert.ok(fs.statSync(l.events).size < 10000); assert.equal(fs.existsSync(l.lock), false);
  fs.writeFileSync(path, 'repaired synthetic notes');
  const repaired = openSession({ ...f, sessionId: 'S1', runner: 'test', hardLimit: 10000 }); assert.equal(repaired.status, 'open'); repaired.session.close();
});

test('a committed runner append over the edit bound is not falsely restored', () => {
  const f = fixture(), opened = openSession({ ...f, sessionId: 'S1', runner: 'test', hardLimit: 100 }); assert.equal(opened.status, 'open');
  const committed = opened.session.record([{ role: 'tool', text: 'x'.repeat(1000) }]);
  const synced = opened.session.sync(); assert.equal(synced.revision, committed.revision); assert.equal(synced.receipt, undefined); assert.equal(synced.workingContextText, committed.workingContextText); opened.session.close();
});

test('accounting contention does not withhold successful recall, show or read', () => {
  const f = fixture(), opened = openSession({ ...f, sessionId: 'S1', runner: 'test', hardLimit: 10000 }); assert.equal(opened.status, 'open'); const s = opened.session;
  s.record([{ role: 'user', text: 'CONTENTION_EVIDENCE' }]); const path = join(s.stateDir, 'events.jsonl.append.lock'), me = holderFor(process.pid, 'test', 10000); s.close(); assert.equal(acquire(path, me).status, 'acquired');
  try { assert.equal(recall({ ...f, sessionId: 'S1', query: 'CONTENTION_EVIDENCE' }).accounting, 'skipped'); assert.equal(show({ ...f, sessionId: 'S1', id: 'e1' }).accounting, 'skipped'); assert.equal(readWorkingContext({ ...f, sessionId: 'S1' }).accounting, 'skipped'); }
  finally { releaseLock(path, me); }
});

test('structured command output stays recallable after Working Context replacement', () => {
  const f = fixture(), opened = openSession({ ...f, sessionId: 'S1', runner: 'test', hardLimit: 100000 });
  assert.equal(opened.status, 'open');
  const s = opened.session;
  s.record([{ role: 'tool', text: '$ test (exit 0)', item: { type: 'commandExecution', aggregatedOutput: 'SYNTHETIC_COMMAND_EVIDENCE' } }]);
  assert.doesNotMatch(fs.readFileSync(s.workingContextPath, 'utf8'), /SYNTHETIC_COMMAND_EVIDENCE/);
  fs.writeFileSync(s.workingContextPath, '# user\nNew context'); s.sync(); s.close();
  assert.equal(recall({ ...f, sessionId: 'S1', query: 'SYNTHETIC_COMMAND_EVIDENCE' }).hits[0]?.id, 'e1');
  assert.match(show({ ...f, sessionId: 'S1', id: 'e1' }).text, /SYNTHETIC_COMMAND_EVIDENCE/);
});

test('paged read refuses invalid UTF-8 and preserves a valid BOM byte for byte', () => {
  const f = fixture(), opened = openSession({ ...f, sessionId: 'S1', runner: 'test', hardLimit: 100000 });
  assert.equal(opened.status, 'open'); const path = opened.session.workingContextPath; opened.session.close();
  fs.writeFileSync(path, Buffer.from([0xc3, 0x28]));
  assert.throws(() => readWorkingContext({ ...f, sessionId: 'S1' }), /encoded data|encoding/i);
  const bytes = Buffer.from('\ufeff# user\nBOM preserved'); fs.writeFileSync(path, bytes);
  const result = readWorkingContext({ ...f, sessionId: 'S1' });
  assert.ok(Buffer.from(result.text.slice(result.text.indexOf('\n') + 1)).equals(bytes));
});

test('relative explicit and environment state roots refuse before any state write', () => {
  assert.throws(() => resolveStateRoot('.state'), /absolute/);
  const previous = process.env.CONTEXT_ENGINE_STATE_DIR;
  try { process.env.CONTEXT_ENGINE_STATE_DIR = '.state'; assert.throws(() => resolveStateRoot(), /absolute/); }
  finally { if (previous === undefined) delete process.env.CONTEXT_ENGINE_STATE_DIR; else process.env.CONTEXT_ENGINE_STATE_DIR = previous; }
  const absolute = resolve(tempDir('state')); assert.equal(resolveStateRoot(absolute), absolute);
});

for (const name of ['.env', '.env.production', '.npmrc', '.pypirc', '.aws/credentials', '.ssh/id_ed25519', '.gnupg/private-keys-v1.d/key', '.codex/auth.json', '.claude/.credentials.json']) test(`cite refuses synthetic project credential location ${name} before reading`, () => {
  const f = fixture(), path = join(f.projectRoot, name);
  fs.mkdirSync(dirname(path), { recursive: true }); fs.writeFileSync(path, 'SYNTHETIC_ONLY');
  const native = fs.readFileSync; let read = false;
  try {
    fs.readFileSync = ((fd: any, ...args: any[]) => {
      if (typeof fd === 'number' && fs.realpathSync(`/proc/self/fd/${fd}`) === path) read = true;
      return (native as any)(fd, ...args);
    }) as typeof fs.readFileSync; syncBuiltinESMExports();
    assert.throws(() => cite(f.projectRoot, name), /credential/); assert.equal(read, false);
  } finally { fs.readFileSync = native; syncBuiltinESMExports(); }
});

test('multipart read requires its first content digest and refuses a changed file', () => {
  const f = fixture(), opened = openSession({ ...f, sessionId: 'S1', runner: 'test', hardLimit: 200000 });
  assert.equal(opened.status, 'open');
  try {
    opened.session.record([{ role: 'user', text: 'A'.repeat(40000) }]);
    const first = readWorkingContext({ ...f, sessionId: 'S1' }); assert.equal(first.parts, 2);
    assert.match(first.sha, /^[a-f0-9]{64}$/);
    assert.throws(() => readWorkingContext({ ...f, sessionId: 'S1', part: 2 }), /digest|sha/);
    assert.equal(readWorkingContext({ ...f, sessionId: 'S1', part: 2, sha: first.sha }).part, 2);
    const path = opened.session.workingContextPath;
    fs.writeFileSync(path, fs.readFileSync(path, 'utf8').replaceAll('A', 'B'));
    assert.throws(() => readWorkingContext({ ...f, sessionId: 'S1', part: 2, sha: first.sha }), /changed.*restart/i);
  } finally { opened.session.close(); }
});

test('same-process interleaved participation writes use unique exclusive temporaries', () => {
  const f = fixture(), nativeOpen = fs.openSync, nativeWrite = fs.writeSync;
  const paths: string[] = [], temporaries = new Set<number>(); let inner = false;
  try {
    fs.openSync = ((path: any, flags: any, mode: any) => {
      const fd = nativeOpen(path, flags, mode);
      if (String(path).endsWith('.tmp')) { paths.push(String(path)); assert.equal(flags, 'wx'); temporaries.add(fd); }
      return fd;
    }) as typeof fs.openSync;
    fs.writeSync = ((fd: number, ...args: any[]) => {
      const written = (nativeWrite as any)(fd, ...args);
      if (temporaries.has(fd) && !inner) { inner = true; setParticipation({ ...f, state: 'off' }); }
      return written;
    }) as typeof fs.writeSync; syncBuiltinESMExports();
    setParticipation({ ...f, state: 'on' });
    assert.equal(new Set(paths).size, 2); assert.equal(participation({ ...f, env: {} }).state, 'on');
  } finally { fs.openSync = nativeOpen; fs.writeSync = nativeWrite; syncBuiltinESMExports(); }
});
test('atomic publication completes repeated short writes without truncation', () => {
  const path = join(tempDir('short-write'), 'snapshot');
  const native = fs.writeSync; const expected = '€漢字'.repeat(40); let calls = 0;
  try {
    fs.writeSync = ((fd: number, bytes: Uint8Array, offset: number, length: number) => {
      calls++; return native(fd, bytes, offset, Math.min(7, length));
    }) as typeof fs.writeSync; syncBuiltinESMExports();
    atomicWrite(path, expected, 'snapshot-tmp');
    assert.equal(fs.readFileSync(path, 'utf8'), expected); assert.ok(calls > 1);
  } finally { fs.writeSync = native; syncBuiltinESMExports(); }
});
test('zero-progress writes refuse publication and keep the prior snapshot', () => {
  const path = join(tempDir('zero-write'), 'snapshot'); fs.writeFileSync(path, 'prior');
  const native = fs.writeSync;
  try {
    fs.writeSync = (() => 0) as typeof fs.writeSync; syncBuiltinESMExports();
    assert.throws(() => atomicWrite(path, 'replacement', 'snapshot-tmp'), /no progress/);
    assert.equal(fs.readFileSync(path, 'utf8'), 'prior');
  } finally { fs.writeSync = native; syncBuiltinESMExports(); }
});

import { ensureDirs, layout } from './store.ts';
import { parseTurns, renderTurns } from './turns.ts';
test('existing shared state root permissions are not changed or used for private state', () => {
  const f = fixture(); fs.mkdirSync(f.stateDir, { mode: 0o755 }); fs.chmodSync(f.stateDir, 0o755);
  assert.throws(() => ensureDirs(layout(f.projectRoot, 'S1', f.stateDir), f.stateDir), /private.*0700/i);
  assert.equal(fs.statSync(f.stateDir).mode & 0o777, 0o755);
  assert.deepEqual(fs.readdirSync(f.stateDir), []);
});
test('rendering cannot sanitize a non-assistant role into assistant authorship', () => {
  for (const role of ['assistant!', 'assistant.', '1assistant', ' assistant', 'assistant\n']) {
    assert.deepEqual(parseTurns(renderTurns([{ role, text: 'UNTRUSTED_NOTE' }])), [{role: 'user', text: 'UNTRUSTED_NOTE'}]);
  }
  assert.deepEqual(parseTurns(renderTurns([{ role: 'Assistant', text: 'ANSWER' }])), [{role: 'assistant', text: 'ANSWER'}]);
});

import { armCrash, InjectedCrash } from './faults.ts';
import { checkRefs } from './refs.ts';
test('multipart read refuses a sparse oversized file before any unbounded payload read', () => {
  const f=fixture(), r=openSession({...f,sessionId:'S1',runner:'test',hardLimit:10000}); assert.equal(r.status,'open');
  const s=r.session; s.record([{role:'user',text:'SMALL'}]); fs.truncateSync(s.workingContextPath,1024*1024*1024);
  const native=fs.readFileSync;
  fs.readFileSync=((path:any,...args:any[])=>{if(typeof path==='number' && fs.fstatSync(path).size>16*1024*1024) throw new Error('UNBOUNDED_PAYLOAD_READ');return (native as any)(path,...args);}) as typeof fs.readFileSync;
  syncBuiltinESMExports();
  try {assert.throws(()=>readWorkingContext({...f,sessionId:'S1'}),/read limit|too large/i);}
  finally {fs.readFileSync=native;syncBuiltinESMExports();s.close();}
});
test('citations refuse invalid UTF-8 and valid citations become stale on invalid-byte replacement', () => {
  const f=fixture(), file=join(f.projectRoot,'source.txt');fs.writeFileSync(file,Buffer.from([0xff,0x0a]));
  assert.throws(()=>cite(f.projectRoot,'source.txt'),/UTF-8|encoded data/i);
  fs.writeFileSync(file,'VALID_SOURCE');const marker=cite(f.projectRoot,'source.txt');
  fs.writeFileSync(file,Buffer.from([0xfe,0x0a]));assert.equal(checkRefs(f.projectRoot,marker)?.refs[0]?.reason,'changed');
});
test('linked participation directory is never read or used for publication', () => {
  const f=fixture(), external=tempDir('participation-outside');fs.mkdirSync(f.stateDir,{mode:0o700});fs.symlinkSync(external,join(f.stateDir,'participation'));
  assert.throws(()=>setParticipation({...f,state:'on'}),/linked|symbolic|verified/i);
  assert.deepEqual(fs.readdirSync(external),[]);
  assert.throws(()=>participation({...f,env:{}}),/linked|symbolic|verified/i);
});
test('a linked state ancestor cannot create an absent external child', () => {
  const f=fixture(), external=tempDir('state-external'), parent=tempDir('state-parent');
  fs.symlinkSync(external,join(parent,'linked'));
  assert.throws(()=>setParticipation({...f,stateDir:join(parent,'linked','absent'),state:'on'}),/linked|verified/i);
  assert.deepEqual(fs.readdirSync(external),[]);
});
test('Working Context directories and files are private under umask 022', () => {
  const mask=process.umask(0o022), f=fixture();
  try {const r=openSession({...f,sessionId:'S1',runner:'test',hardLimit:10000});assert.equal(r.status,'open');
    const s=r.session;s.record([{role:'user',text:'SYNTHETIC_PRIVATE_TASK'}]);
    assert.equal(fs.statSync(s.workingContextPath).mode&0o777,0o600);
    assert.equal(fs.statSync(dirname(s.workingContextPath)).mode&0o777,0o700);
    assert.equal(fs.statSync(dirname(dirname(s.workingContextPath))).mode&0o777,0o700);s.close();
  }finally{process.umask(mask);}
});
test('crash recovery preserves a committed runner append over an edit of its stale parent', () => {
  const f=fixture(), first=openSession({...f,sessionId:'S1',runner:'test',hardLimit:10000});assert.equal(first.status,'open');
  const s=first.session;s.record([{role:'user',text:'INITIAL_TASK'}]);
  armCrash('before-wc');try{assert.throws(()=>s.record([{role:'tool',text:'COMMITTED_RUNNER_EVENT'}]),InjectedCrash);}finally{armCrash(null);}
  fs.writeFileSync(s.workingContextPath,'[[CTX_TURN 1 role=user]]\nEDIT_OF_STALE_PARENT');
  const next=openSession({...f,sessionId:'S1',runner:'test',hardLimit:10000});assert.equal(next.status,'open');
  const result=next.session.sync();assert.match(result.workingContextText,/COMMITTED_RUNNER_EVENT/);
  assert.equal(recall({...f,sessionId:'S1',query:'EDIT_OF_STALE_PARENT'}).total,1);
  assert.equal(result.receipt?.kind,'restored');next.session.close();
});
