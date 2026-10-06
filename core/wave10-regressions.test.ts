import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { fixture, tempDir } from './testing.ts';
import { openSession, recall } from './index.ts';
import { appendLog } from './store.ts';
import { cite } from './refs.ts';

function opened() {
  const f = fixture(), r = openSession({ ...f, sessionId: 'S1', runner: 'test', hardLimit: 10000 });
  assert.equal(r.status, 'open');
  return { f, s: r.session };
}

test('wave10: a failed append retains the restoration receipt until a successful result', () => {
  const { s } = opened(); s.record([{ role: 'user', text: 'ORIGINAL' }]);
  fs.writeFileSync(s.workingContextPath, '');
  const native = fs.writeSync;
  fs.writeSync = ((fd: number, data: any, ...args: any[]) => {
    if (fs.readlinkSync(`/proc/self/fd/${fd}`).endsWith('/events.jsonl') && String(data).includes('runner-events')) throw new Error('synthetic append failure');
    return (native as any)(fd, data, ...args);
  }) as typeof fs.writeSync;
  syncBuiltinESMExports();
  try { assert.throws(() => s.record([{ role: 'user', text: 'FAILED' }]), /synthetic append failure/); }
  finally { fs.writeSync = native; syncBuiltinESMExports(); }
  assert.equal(s.sync().receipt?.kind, 'restored');
  assert.equal(s.sync().receipt, undefined); s.close();
});

test('wave10: exhausted event sequence refuses before appending or invalidating HEAD', () => {
  const { f, s } = opened(), state = s.stateDir; s.close();
  appendLog(join(state, 'events.jsonl'), { type: 'runner-events', events: [{ seq: Number.MAX_SAFE_INTEGER, event: { role: 'user', text: 'LAST_VALID_SEQUENCE' } }] });
  const r = openSession({ ...f, sessionId: 'S1', runner: 'test', hardLimit: 10000 }); assert.equal(r.status, 'open');
  const before = fs.readFileSync(join(state, 'events.jsonl')), head = fs.readFileSync(join(state, 'HEAD'));
  assert.throws(() => r.session.record([{ role: 'user', text: 'OVERFLOW' }]), /sequence exhausted/);
  assert.deepEqual(fs.readFileSync(join(state, 'events.jsonl')), before);
  assert.deepEqual(fs.readFileSync(join(state, 'HEAD')), head); r.session.close();
});

test('wave10: exhausted revision counter refuses before adding a runner event', () => {
  const { f, s } = opened(); s.record([{ role: 'user', text: 'LAST_REVISION' }]); const state = s.stateDir; s.close();
  const headPath = join(state, 'HEAD'), head = JSON.parse(fs.readFileSync(headPath, 'utf8'));
  fs.renameSync(join(state, 'revisions', `${head.rev}.md`), join(state, 'revisions', `${Number.MAX_SAFE_INTEGER}.md`));
  head.rev = Number.MAX_SAFE_INTEGER; fs.writeFileSync(headPath, JSON.stringify(head));
  const r = openSession({ ...f, sessionId: 'S1', runner: 'test', hardLimit: 10000 }); assert.equal(r.status, 'open');
  const log = fs.readFileSync(join(state, 'events.jsonl')), before = fs.readFileSync(headPath);
  assert.throws(() => r.session.record([{ role: 'user', text: 'MUST_NOT_APPEND' }]), /revision counter exhausted/);
  assert.deepEqual(fs.readFileSync(join(state, 'events.jsonl')), log); assert.deepEqual(fs.readFileSync(headPath), before); r.session.close();
});

test('wave10: oversized managed gitignore refuses without reading its payload', () => {
  const f = fixture(), dir = join(f.projectRoot, '.context-engine'); fs.mkdirSync(dir);
  fs.writeFileSync(join(dir, '.gitignore'), ''); fs.truncateSync(join(dir, '.gitignore'), 32 * 1024 * 1024);
  const native = fs.readFileSync; let allocated = false;
  fs.readFileSync = ((path: any, ...args: any[]) => {
    if (typeof path === 'number' && fs.readlinkSync(`/proc/self/fd/${path}`).endsWith('/.gitignore')) { allocated = true; throw new Error('test prevented unbounded allocation'); }
    return (native as any)(path, ...args);
  }) as typeof fs.readFileSync; syncBuiltinESMExports();
  try { assert.throws(() => openSession({ ...f, sessionId: 'S1', runner: 'test', hardLimit: 10000 }), /gitignore/); assert.equal(allocated, false); }
  finally { fs.readFileSync = native; syncBuiltinESMExports(); }
});

test('wave10: Git citation probes time out without prompting or lazy fetch', () => {
  const f = fixture(), bin = tempDir('git-probe'), log = join(bin, 'flags');
  fs.writeFileSync(join(bin, 'git'), `#!/bin/sh\nprintf '%s %s' "$GIT_TERMINAL_PROMPT" "$GIT_NO_LAZY_FETCH" > '${log}'\nexec /bin/sleep 30\n`, { mode: 0o700 });
  const old = process.env.PATH; process.env.PATH = bin + ':' + old;
  const started = Date.now();
  try { assert.throws(() => cite(f.projectRoot, 'commit:abcdef123456'), /no commit/); }
  finally { process.env.PATH = old; }
  assert.ok(Date.now() - started < 5000, 'one probe must stop within its timeout'); assert.equal(fs.readFileSync(log, 'utf8'), '0 1');
});

test('wave10: credential-bearing recall query is not persisted in accounting', () => {
  const { f, s } = opened(); s.record([{ role: 'user', text: 'ordinary evidence' }]);
  const synthetic = 'ghp_' + 'A'.repeat(36);
  recall({ ...f, sessionId: 'S1', query: synthetic });
  const log = fs.readFileSync(join(s.stateDir, 'events.jsonl'), 'utf8');
  assert.equal(log.includes(synthetic), false); assert.match(log, /omitted-credential/); s.close();
});

test('wave10: materialization makes no lexical recursive directory calls', () => {
  const { s } = opened(), native = fs.mkdirSync, outside = tempDir('materialize-outside');
  const root = dirname(dirname(s.workingContextPath)); let unsafe = false;
  fs.mkdirSync = ((path: any, opts: any) => {
    if (String(path) === dirname(s.workingContextPath) && opts?.recursive) {
      unsafe = true; fs.renameSync(root, root + '.old'); fs.symlinkSync(outside, root);
    }
    return native(path, opts);
  }) as typeof fs.mkdirSync; syncBuiltinESMExports();
  try { s.record([{ role: 'user', text: 'MATERIALIZE' }]); }
  finally { fs.mkdirSync = native; syncBuiltinESMExports(); if (unsafe) { fs.unlinkSync(root); fs.renameSync(root + '.old', root); } s.close(); }
  assert.equal(unsafe, false); assert.deepEqual(fs.readdirSync(outside), []);
});
