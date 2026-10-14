import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { fixture } from './testing.ts';
import { openSession, type Session } from './index.ts';
import { readLog } from './store.ts';

const resolved = (path: unknown): string => {
  if (typeof path === 'number') return fs.readlinkSync(`/proc/self/fd/${path}`);
  const name = String(path), match = /^\/proc\/self\/fd\/(\d+)(\/.*)?$/.exec(name);
  return match ? fs.readlinkSync(`/proc/self/fd/${match[1]}`) + (match[2] ?? '') : name;
};

for (const recovery of [false, true]) test(`issue32: completed chunk during durable logging is captured (${recovery})`, () => {
  const f = fixture(), opts = { ...f, sessionId: 'S1', runner: 'test', hardLimit: 10000 };
  const opened = openSession(opts); assert.equal(opened.status, 'open');
  let s: Session = opened.session;
  s.record([{ role: 'user', text: 'BASE' }]);
  const wc = s.workingContextPath, log = join(s.stateDir, 'events.jsonl'), writer = fs.openSync(wc, 'r+');
  const nativeRename = fs.renameSync, nativeWrite = fs.writeSync;
  let changed = false, suffix = false, intercept = true;
  const prefix = 'CHUNK_PREFIX', completed = prefix + '_COMPLETED_EDIT';
  fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
    if (!changed && resolved(to) === wc) { changed = true; fs.ftruncateSync(writer, 0); nativeWrite(writer, Buffer.from(prefix), 0, prefix.length, 0); }
    nativeRename(from, to);
  });
  fs.writeSync = ((fd: number, data: any, ...args: any[]) => {
    const restore = intercept && changed && resolved(fd) === log && String(data).includes('"type":"restored"');
    if (restore && recovery) throw Object.assign(new Error('synthetic interrupted late logging'), { code: 'EIO' });
    const n = (nativeWrite as any)(fd, data, ...args);
    if (restore && !suffix) { suffix = true; nativeWrite(writer, Buffer.from('_COMPLETED_EDIT'), 0, 15, prefix.length); }
    return n;
  }) as typeof fs.writeSync; syncBuiltinESMExports();
  try {
    if (recovery) {
      assert.throws(() => s.record([{ role: 'assistant', text: 'APPEND' }]), /publication failed/);
      fs.renameSync = nativeRename; fs.writeSync = nativeWrite; syncBuiltinESMExports();
      assert.throws(() => s.sync(), /publication failed|close and reopen/);
      s.close(); intercept = true;
      fs.writeSync = ((fd: number, data: any, ...args: any[]) => {
        const n = (nativeWrite as any)(fd, data, ...args);
        if (!suffix && resolved(fd) === log && String(data).includes('"type":"restored"')) { suffix = true; nativeWrite(writer, Buffer.from('_COMPLETED_EDIT'), 0, 15, prefix.length); }
        return n;
      }) as typeof fs.writeSync; syncBuiltinESMExports();
      const again = openSession(opts); assert.equal(again.status, 'open'); s = again.session;
    } else s.record([{ role: 'assistant', text: 'APPEND' }]);
  } finally { fs.renameSync = nativeRename; fs.writeSync = nativeWrite; syncBuiltinESMExports(); }
  try {
    assert.ok(changed && suffix, 'both controlled writer chunks actually landed');
    assert.equal(fs.readFileSync(writer, 'utf8'), completed);
    const rejected = [...readLog(log)].filter(row => row.type === 'restored').map(row => row.rejected);
    assert.ok(rejected.includes(completed), 'a successful append gives the core a bounded chance to sample the completed suffix');
    assert.equal(rejected.filter(text => text === completed).length, 1, 'stable rereads do not duplicate the same local sample');
    s.close();
  } finally { fs.closeSync(writer); }
});

for (const recovery of [false, true]) for (const code of ['EIO', 'ENOSPC']) test(`issue32: ${code} on completed sample preserves full artifact (${recovery})`, () => {
  const f = fixture(), opts = { ...f, sessionId: 'S1', runner: 'test', hardLimit: 10000 };
  const opened = openSession(opts); assert.equal(opened.status, 'open');
  const s = opened.session; s.record([{ role: 'user', text: 'BASE' }]);
  const wc = s.workingContextPath, log = join(s.stateDir, 'events.jsonl'), writer = fs.openSync(wc, 'r+');
  const nativeRename = fs.renameSync, nativeWrite = fs.writeSync;
  let changed = false, suffix = false, failed = false, recovering = false;
  const prefix = 'CHUNK_PREFIX', completed = prefix + '_COMPLETED_EDIT';
  fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
    if (!changed && resolved(to) === wc) { changed = true; fs.ftruncateSync(writer, 0); nativeWrite(writer, Buffer.from(prefix), 0, prefix.length, 0); }
    nativeRename(from, to);
  });
  const write = ((fd: number, data: any, ...args: any[]) => {
    const restore = changed && resolved(fd) === log && String(data).includes('"type":"restored"');
    if (restore && recovery && !recovering) throw Object.assign(new Error('synthetic interrupted logging'), { code: 'EIO' });
    if (restore && String(data).includes(completed)) { failed = true; throw Object.assign(new Error(`synthetic completed sample ${code}`), { code }); }
    const n = (nativeWrite as any)(fd, data, ...args);
    if (restore && !suffix) { suffix = true; nativeWrite(writer, Buffer.from('_COMPLETED_EDIT'), 0, 15, prefix.length); }
    return n;
  }) as typeof fs.writeSync;
  fs.writeSync = write; syncBuiltinESMExports();
  try {
    assert.throws(() => s.record([{ role: 'assistant', text: 'APPEND' }]), /publication failed/);
    if (recovery) {
      fs.renameSync = nativeRename; fs.writeSync = nativeWrite; syncBuiltinESMExports(); s.close();
      recovering = true; fs.writeSync = write; syncBuiltinESMExports();
      assert.throws(() => openSession(opts), /publication failed/);
    } else assert.throws(() => s.sync(), /close and reopen/);
  } finally { fs.renameSync = nativeRename; fs.writeSync = nativeWrite; syncBuiltinESMExports(); }
  try {
    assert.ok(failed && suffix, 'failure occurred at the completed-byte append');
    const head = JSON.parse(fs.readFileSync(join(s.stateDir, 'HEAD'), 'utf8'));
    const artifact = `${wc}.ce-preserved-${head.sha}.bak`, marker = join(s.stateDir, 'working-context-preservation.json');
    assert.equal(fs.readFileSync(artifact, 'utf8'), completed);
    assert.equal(fs.statSync(artifact).ino, fs.fstatSync(writer).ino);
    assert.equal(JSON.parse(fs.readFileSync(marker, 'utf8')).ino, fs.fstatSync(writer).ino);
    if (!recovery) s.close();
    const again = openSession(opts); assert.equal(again.status, 'open');
    assert.ok([...readLog(log)].some(row => row.type === 'restored' && row.rejected === completed));
    assert.equal(fs.existsSync(artifact), false);
    assert.equal(fs.existsSync(marker), false);
    again.session.close();
  } finally { fs.closeSync(writer); }
});

test('issue32: a writer completing after all four samples remains outside capture', () => {
  const f = fixture(), opts = { ...f, sessionId: 'S1', runner: 'test', hardLimit: 10000 };
  const opened = openSession(opts); assert.equal(opened.status, 'open');
  const s = opened.session; s.record([{ role: 'user', text: 'BASE' }]);
  const wc = s.workingContextPath, log = join(s.stateDir, 'events.jsonl'), writer = fs.openSync(wc, 'r+');
  const nativeRename = fs.renameSync, nativeWrite = fs.writeSync;
  let changed = false, appended = 0, image = 'CHUNK_PREFIX';
  fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
    if (!changed && resolved(to) === wc) { changed = true; fs.ftruncateSync(writer, 0); nativeWrite(writer, Buffer.from(image), 0, image.length, 0); }
    nativeRename(from, to);
  });
  fs.writeSync = ((fd: number, data: any, ...args: any[]) => {
    const n = (nativeWrite as any)(fd, data, ...args);
    if (changed && resolved(fd) === log && String(data).includes('"type":"restored"')) {
      const suffix = `_NEXT_${++appended}`; nativeWrite(writer, Buffer.from(suffix), 0, suffix.length, image.length); image += suffix;
    }
    return n;
  }) as typeof fs.writeSync; syncBuiltinESMExports();
  try { s.record([{ role: 'assistant', text: 'APPEND' }]); }
  finally { fs.renameSync = nativeRename; fs.writeSync = nativeWrite; syncBuiltinESMExports(); }
  try {
    assert.equal(appended, 4, 'the loop has a hard bound even while the writer advances');
    assert.equal(fs.readFileSync(writer, 'utf8'), image);
    const retained = [...readLog(log)].filter(row => row.type === 'restored');
    assert.equal(retained.length, 4);
    assert.ok(!retained.some(row => row.rejected === image), 'the suffix completed after the fourth sample is deliberately not claimed captured');
    assert.equal(new Set(retained.map(row => (row.notice as { id: string }).id)).size, 4);
    s.close();
  } finally { fs.closeSync(writer); }
});

test('issue32: stable publication creates no restoration sample or notice', () => {
  const f = fixture(), opened = openSession({ ...f, sessionId: 'S1', runner: 'test', hardLimit: 10000 }); assert.equal(opened.status, 'open');
  const s = opened.session; s.record([{ role: 'user', text: 'BASE' }]);
  const r = s.record([{ role: 'assistant', text: 'APPEND' }]);
  assert.equal(r.restoreNotices, undefined);
  assert.equal([...readLog(join(s.stateDir, 'events.jsonl'))].filter(row => row.type === 'restored').length, 0);
  s.close();
});
