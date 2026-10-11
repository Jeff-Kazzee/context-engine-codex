import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { type PathLike } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { fixture } from './testing.ts';
import { openSession } from './index.ts';
import { layout } from './store.ts';
import type { FaultPlan } from './process-faults.ts';
import { startCli } from './testing.ts';

function seeded() {
  const options = { ...fixture(), sessionId: 'PR6', runner: 'test', hardLimit: 10_000 };
  const opened = openSession(options);
  assert.equal(opened.status, 'open');
  opened.session.record([{ role: 'user', text: 'BASE' }]);
  return { options, session: opened.session, paths: layout(options.projectRoot, options.sessionId, options.stateDir) };
}

for (const operation of ['runner append', 'native compaction']) test(`a hard-link-disabled workspace refuses ${operation} before publishing HEAD`, t => {
  const { session, paths } = seeded();
  const beforeHead = fs.readFileSync(paths.head, 'utf8');
  const beforeContext = fs.readFileSync(paths.workingContext, 'utf8');
  const beforeRevisions = fs.readdirSync(paths.revisions);
  const native = fs.linkSync;
  let refused = false;
  const spy = t.mock.method(fs, 'linkSync', (from: PathLike, to: PathLike) => {
    const parent = fs.realpathSync(dirname(String(to)));
    if (parent === dirname(paths.workingContext) || parent.startsWith(`${dirname(paths.workingContext)}/`)) {
      refused = true;
      throw Object.assign(new Error('fixture workspace disallows hard links'), { code: 'EPERM' });
    }
    return native(from, to);
  });
  syncBuiltinESMExports();
  try {
    const events = [{ role: 'tool', text: 'APPEND' }];
    assert.throws(() => operation === 'runner append' ? session.record(events) : session.nativeCompaction(events), /hard.link|disallows/);
    assert.equal(refused, true);
    assert.equal(fs.readFileSync(paths.head, 'utf8'), beforeHead, 'unsupported publication must not advance HEAD');
    assert.equal(fs.readFileSync(paths.workingContext, 'utf8'), beforeContext);
    assert.deepEqual(fs.readdirSync(paths.revisions), beforeRevisions);
    assert.deepEqual(fs.readdirSync(dirname(paths.workingContext)).filter(name => name.includes('.ce-probe-')), []);
  } finally { spy.mock.restore(); syncBuiltinESMExports(); session.close(); }
});

for (const size of [32, 50_000]) test(`an unauthenticated private preservation-name collision of ${size} bytes is retained unread`, t => {
  const { options, session, paths } = seeded();
  session.close();
  const head = JSON.parse(fs.readFileSync(paths.head, 'utf8'));
  head.materialized = false;
  fs.writeFileSync(paths.head, JSON.stringify(head));
  const preserved = `${paths.workingContext}.ce-preserved-${head.sha}.bak`;
  const bytes = Buffer.alloc(size, 'U');
  fs.writeFileSync(preserved, bytes, { mode: 0o600 });
  const collision = fs.statSync(preserved);
  const beforeContext = fs.readFileSync(paths.workingContext);
  const beforeEvents = fs.readFileSync(paths.events);
  const read = fs.readSync;
  let payloadReads = 0;
  const spy = t.mock.method(fs, 'readSync', (...args: unknown[]) => {
    const fd = args[0];
    if (typeof fd === 'number') {
      const st = fs.fstatSync(fd);
      if (st.dev === collision.dev && st.ino === collision.ino) payloadReads++;
    }
    return Reflect.apply(read, fs, args);
  });
  syncBuiltinESMExports();
  let reopened: ReturnType<typeof openSession> | undefined;
  try {
    assert.throws(() => { reopened = openSession(options); }, /recovery artifact|preservation/);
  } finally {
    spy.mock.restore(); syncBuiltinESMExports();
    if (reopened?.status === 'open') reopened.session.close();
  }
  assert.equal(payloadReads, 0, 'a collision must be authenticated before reading bytes');
  assert.equal(fs.statSync(preserved).ino, collision.ino);
  assert.deepEqual(fs.readFileSync(preserved), bytes);
  assert.deepEqual(fs.readFileSync(paths.workingContext), beforeContext);
  assert.deepEqual(fs.readFileSync(paths.events), beforeEvents);
});

test('a substituted preservation name survives a failed predecessor inode check', t => {
  const { session, paths } = seeded();
  const native = fs.linkSync;
  const beforeContext = fs.readFileSync(paths.workingContext);
  let substituted: string | undefined;
  const spy = t.mock.method(fs, 'linkSync', (from: PathLike, to: PathLike) => {
    native(from, to);
    if (String(to).includes('.ce-preserved-')) {
      substituted = join(dirname(paths.workingContext), String(to).split('/').at(-1)!);
      fs.unlinkSync(to);
      fs.writeFileSync(to, 'SUBSTITUTED_PRIVATE_BACKUP', { mode: 0o600 });
    }
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => session.record([{ role: 'tool', text: 'APPEND' }]), /preservation|publication|recovery artifact/);
    assert.ok(substituted);
    assert.equal(fs.existsSync(substituted), true, 'a failed inode check must preserve the substituted file');
    assert.equal(fs.readFileSync(substituted, 'utf8'), 'SUBSTITUTED_PRIVATE_BACKUP');
    assert.deepEqual(fs.readFileSync(paths.workingContext), beforeContext);
    assert.doesNotMatch(fs.readFileSync(paths.events, 'utf8'), /SUBSTITUTED_PRIVATE_BACKUP/);
  } finally { spy.mock.restore(); syncBuiltinESMExports(); session.close(); }
});

for (const phase of ['before', 'after']) test(`a public preservation-name replacement ${phase} its retirement move survives unread`, t => {
  const { session, paths } = seeded();
  const native = fs.renameSync;
  let backup: string | undefined;
  const spy = t.mock.method(fs, 'renameSync', (from: PathLike, to: PathLike) => {
    const retirement = String(from).includes('.ce-preserved-') && String(to).endsWith('/predecessor');
    if (retirement && phase === 'before') {
      fs.unlinkSync(from);
      fs.writeFileSync(from, 'LATE_PRIVATE_BACKUP', { mode: 0o600 });
    }
    native(from, to);
    if (retirement) {
      if (phase === 'after') fs.writeFileSync(from, 'LATE_PRIVATE_BACKUP', { mode: 0o600 });
      backup = fs.realpathSync(phase === 'before' ? to : from);
    }
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => session.record([{ role: 'tool', text: 'APPEND' }]), /retirement|publication/);
    assert.ok(backup);
    assert.equal(fs.readFileSync(backup, 'utf8'), 'LATE_PRIVATE_BACKUP');
    assert.doesNotMatch(fs.readFileSync(paths.events, 'utf8'), /LATE_PRIVATE_BACKUP/);
  } finally { spy.mock.restore(); syncBuiltinESMExports(); session.close(); }
});

const opening = ['--session', 'PR6', '--runner', 'test', '--hard-limit', '10000'];
const event = (text: string) => JSON.stringify({ role: 'tool', text });

test('SIGKILL after linking but before authenticating the predecessor preserves both names and refuses restart', { timeout: 30_000 }, async () => {
  const options = fixture();
  assert.equal((await startCli(options, ['record', ...opening], { input: event('BASE') }).done).code, 0);
  const paths = layout(options.projectRoot, 'PR6', options.stateDir);
  const before = fs.readFileSync(paths.workingContext);
  const killed = await startCli(options, ['record', ...opening], {
    input: event('APPEND'),
    fault: { call: 'linkSync', path: '\\.ce-preserved-[a-f0-9]{64}\\.bak$', at: 'after', action: 'kill' },
  }).done;
  assert.equal(killed.signal, 'SIGKILL', killed.stderr);
  const head = fs.readFileSync(paths.head);
  const preserved = `${paths.workingContext}.ce-preserved-${JSON.parse(head.toString()).sha}.bak`;
  const beforeArtifact = fs.statSync(preserved);
  assert.equal(fs.existsSync(join(paths.stateDir, 'working-context-preservation.json')), false);
  assert.equal(beforeArtifact.ino, fs.statSync(paths.workingContext).ino);
  assert.equal(beforeArtifact.nlink, 2);
  const restarted = await startCli(options, ['sync', ...opening]).done;
  assert.notEqual(restarted.code, 0);
  assert.match(restarted.stdout + restarted.stderr, /unauthenticated|recovery artifact/);
  assert.deepEqual(fs.readFileSync(paths.head), head);
  assert.deepEqual(fs.readFileSync(paths.workingContext), before);
  assert.deepEqual(fs.readFileSync(preserved), before);
  assert.equal(fs.statSync(preserved).ino, beforeArtifact.ino);
});

const boundaries: Array<{ name: string; fault: FaultPlan }> = [
  { name: 'after linked-marker rename', fault: { call: 'renameSync', path: '/working-context-preservation\\.json$', at: 'after', action: 'kill' } },
  { name: 'before retirement move', fault: { call: 'renameSync', path: '\\.ce-retired-[0-9a-f]{32}/predecessor$', at: 'before', action: 'kill' } },
  { name: 'after retirement move', fault: { call: 'renameSync', path: '\\.ce-retired-[0-9a-f]{32}/predecessor$', at: 'after', action: 'kill' } },
  { name: 'before predecessor deletion', fault: { call: 'unlinkSync', path: '\\.ce-retired-[0-9a-f]{32}/predecessor$', at: 'before', action: 'kill' } },
  { name: 'after predecessor deletion', fault: { call: 'unlinkSync', path: '\\.ce-retired-[0-9a-f]{32}/predecessor$', at: 'after', action: 'kill' } },
  { name: 'before retirement-directory deletion', fault: { call: 'rmdirSync', path: '\\.ce-retired-[0-9a-f]{32}$', at: 'before', action: 'kill' } },
  { name: 'after retirement-directory deletion', fault: { call: 'rmdirSync', path: '\\.ce-retired-[0-9a-f]{32}$', at: 'after', action: 'kill' } },
  { name: 'before marker deletion', fault: { call: 'unlinkSync', path: '/working-context-preservation\\.json$', at: 'before', action: 'kill' } },
  { name: 'after marker deletion', fault: { call: 'unlinkSync', path: '/working-context-preservation\\.json$', at: 'after', action: 'kill' } },
];

for (const { name, fault } of boundaries) test(`SIGKILL ${name} restarts with authenticated inode recovery`, { timeout: 30_000 }, async () => {
  const options = fixture();
  assert.equal((await startCli(options, ['record', ...opening], { input: event('BASE') }).done).code, 0);
  const paths = layout(options.projectRoot, 'PR6', options.stateDir);
  const predecessor = fs.statSync(paths.workingContext);
  const killed = await startCli(options, ['record', ...opening], { input: event('APPEND'), fault }).done;
  assert.equal(killed.signal, 'SIGKILL', killed.stderr);
  const marker = join(paths.stateDir, 'working-context-preservation.json');
  if (fs.existsSync(marker)) {
    const record = JSON.parse(fs.readFileSync(marker, 'utf8'));
    assert.equal(record.dev, predecessor.dev);
    assert.equal(record.ino, predecessor.ino);
    assert.equal(record.sha, JSON.parse(fs.readFileSync(paths.head, 'utf8')).sha);
  }
  const restarted = await startCli(options, ['sync', ...opening]).done;
  assert.equal(restarted.code, 0, restarted.stderr);
  const head = JSON.parse(fs.readFileSync(paths.head, 'utf8'));
  assert.equal(head.materialized, true);
  assert.equal(head.rev, 2);
  assert.equal(fs.readFileSync(paths.workingContext, 'utf8'), fs.readFileSync(join(paths.revisions, '2.md'), 'utf8'));
  assert.equal(fs.readFileSync(paths.workingContext, 'utf8').split('APPEND').length - 1, 1);
  assert.equal(fs.existsSync(marker), false);
  assert.deepEqual(fs.readdirSync(dirname(paths.workingContext)).filter(name => name.includes('.ce-preserved-') || name.includes('.ce-retired-')), []);
});

for (const at of ['before', 'after']) test(`an identity-marker publication failure ${at} rename retains the predecessor`, t => {
  const { options, session, paths } = seeded();
  const before = fs.readFileSync(paths.workingContext);
  const native = fs.renameSync;
  let failed = false;
  const spy = t.mock.method(fs, 'renameSync', (from: PathLike, to: PathLike) => {
    const hit = !failed && String(to).endsWith('/working-context-preservation.json');
    if (hit && at === 'before') { failed = true; throw Object.assign(new Error('fixture marker failure'), { code: 'ENOSPC' }); }
    native(from, to);
    if (hit) { failed = true; throw Object.assign(new Error('fixture marker failure'), { code: 'EIO' }); }
  });
  syncBuiltinESMExports();
  try { assert.throws(() => session.record([{ role: 'tool', text: 'APPEND' }]), /recovery artifact/); }
  finally { spy.mock.restore(); syncBuiltinESMExports(); session.close(); }
  assert.equal(failed, true);
  assert.deepEqual(fs.readFileSync(paths.workingContext), before);
  const head = JSON.parse(fs.readFileSync(paths.head, 'utf8'));
  const preserved = `${paths.workingContext}.ce-preserved-${head.sha}.bak`;
  assert.deepEqual(fs.readFileSync(preserved), before);
  const identity = fs.statSync(preserved);
  if (at === 'before') {
    assert.throws(() => openSession(options), /recovery artifact/);
    assert.equal(fs.statSync(preserved).ino, identity.ino);
  } else {
    const reopened = openSession(options);
    assert.equal(reopened.status, 'open');
    reopened.session.close();
    assert.equal(fs.existsSync(preserved), false);
  }
});

for (const failure of ['move EXDEV', 'retirement fsync EIO', 'retired-marker ENOSPC']) test(`a ${failure} keeps restart recovery possible`, t => {
  const { options, session, paths } = seeded();
  const rename = fs.renameSync, flush = fs.fsyncSync;
  let failed = false;
  const renameSpy = t.mock.method(fs, 'renameSync', (from: PathLike, to: PathLike) => {
    if (!failed && failure === 'move EXDEV' && String(to).endsWith('/predecessor')) {
      failed = true; throw Object.assign(new Error('fixture cross-device refusal'), { code: 'EXDEV' });
    }
    if (!failed && failure === 'retired-marker ENOSPC' && String(to).endsWith('/working-context-preservation.json')
      && fs.readFileSync(from, 'utf8').includes('"stage":"retired"')) {
      failed = true; throw Object.assign(new Error('fixture completion marker refusal'), { code: 'ENOSPC' });
    }
    return rename(from, to);
  });
  const flushSpy = t.mock.method(fs, 'fsyncSync', (fd: number) => {
    if (!failed && failure === 'retirement fsync EIO' && fs.readlinkSync(`/proc/self/fd/${fd}`).includes('.ce-retired-')
      && fs.existsSync(`/proc/self/fd/${fd}/predecessor`)) {
      failed = true; throw Object.assign(new Error('fixture retirement flush refusal'), { code: 'EIO' });
    }
    return flush(fd);
  });
  syncBuiltinESMExports();
  try { assert.throws(() => session.record([{ role: 'tool', text: 'APPEND' }]), /retirement|recovery artifact/); }
  finally { renameSpy.mock.restore(); flushSpy.mock.restore(); syncBuiltinESMExports(); session.close(); }
  assert.equal(failed, true);
  const reopened = openSession(options);
  assert.equal(reopened.status, 'open');
  try {
    assert.match(reopened.session.sync().workingContextText, /APPEND/);
    assert.equal(fs.existsSync(join(paths.stateDir, 'working-context-preservation.json')), false);
    assert.deepEqual(fs.readdirSync(dirname(paths.workingContext)).filter(name => name.includes('.ce-preserved-') || name.includes('.ce-retired-')), []);
  } finally { reopened.session.close(); }
});

test('an authenticated name with a substituted inode is refused before reading its bytes', t => {
  const { options, session, paths } = seeded();
  const native = fs.renameSync;
  const spy = t.mock.method(fs, 'renameSync', (from: PathLike, to: PathLike) => {
    if (String(to).endsWith('/context.md')) throw new Error('fixture stops before materialization');
    return native(from, to);
  });
  syncBuiltinESMExports();
  try { assert.throws(() => session.record([{ role: 'tool', text: 'APPEND' }]), /recovery artifact/); }
  finally { spy.mock.restore(); syncBuiltinESMExports(); session.close(); }
  const head = JSON.parse(fs.readFileSync(paths.head, 'utf8'));
  const preserved = `${paths.workingContext}.ce-preserved-${head.sha}.bak`;
  fs.unlinkSync(preserved);
  fs.writeFileSync(preserved, 'SUBSTITUTED_AUTHENTICATED_NAME', { mode: 0o600 });
  const collision = fs.statSync(preserved), read = fs.readSync;
  let reads = 0;
  const readSpy = t.mock.method(fs, 'readSync', (...args: unknown[]) => {
    if (typeof args[0] === 'number' && fs.fstatSync(args[0]).ino === collision.ino) reads++;
    return Reflect.apply(read, fs, args);
  });
  syncBuiltinESMExports();
  try { assert.throws(() => openSession(options), /recovery artifact/); }
  finally { readSpy.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(reads, 0);
  assert.equal(fs.statSync(preserved).ino, collision.ino);
  assert.equal(fs.readFileSync(preserved, 'utf8'), 'SUBSTITUTED_AUTHENTICATED_NAME');
  assert.doesNotMatch(fs.readFileSync(paths.events, 'utf8'), /SUBSTITUTED_AUTHENTICATED_NAME/);
});
