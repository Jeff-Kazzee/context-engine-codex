import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { type PathLike } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { fixture } from './testing.ts';
import { openSession } from './index.ts';
import { layout } from './store.ts';

function seeded() {
  const options = { ...fixture(), sessionId: 'PRESERVED', runner: 'test', hardLimit: 10_000 };
  const opened = openSession(options);
  assert.equal(opened.status, 'open');
  opened.session.record([{ role: 'user', text: 'BASE' }]);
  return { options, session: opened.session, paths: layout(options.projectRoot, options.sessionId, options.stateDir) };
}

test('a blank clearing edit immediately before materialization has a restore receipt', t => {
  const { session, paths } = seeded();
  const rename = fs.renameSync;
  let edited = false;
  const spy = t.mock.method(fs, 'renameSync', (from: PathLike, to: PathLike) => {
    if (!edited && String(to).endsWith('/context.md')) {
      edited = true;
      fs.writeFileSync(paths.workingContext, ' \n\t');
    }
    return rename(from, to);
  });
  syncBuiltinESMExports();
  try {
    const result = session.record([{ role: 'tool', text: 'APPEND' }]);
    assert.equal(edited, true);
    assert.equal(result.receipt?.kind, 'restored');
    const rows = fs.readFileSync(paths.events, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(rows.filter(row => row.type === 'restored' && row.rejected === ' \n\t').length, 1);
  } finally { spy.mock.restore(); syncBuiltinESMExports(); session.close(); }
});

for (const code of ['EIO', 'ENOSPC']) test(`a post-rename ${code} preserves the observed edit and retry recovers it`, t => {
  const { options, session, paths } = seeded();
  const rename = fs.renameSync, write = fs.writeSync;
  let edited = false, failed = false;
  const renameSpy = t.mock.method(fs, 'renameSync', (from: PathLike, to: PathLike) => {
    if (!edited && String(to).endsWith('/context.md')) {
      edited = true;
      const writer = fs.openSync(paths.workingContext, 'r+');
      try {
        fs.ftruncateSync(writer, 0);
        fs.writeSync(writer, Buffer.from('OBSERVED_EDIT'));
        return rename(from, to);
      } finally { fs.closeSync(writer); }
    }
    return rename(from, to);
  });
  const writeSpy = t.mock.method(fs, 'writeSync', (...args: unknown[]) => {
    const [fd, bytes] = args;
    if (edited && !failed && typeof fd === 'number' && Buffer.isBuffer(bytes)
      && fs.readlinkSync(`/proc/self/fd/${fd}`) === paths.events && bytes.includes('"type":"restored"')) {
      failed = true;
      throw Object.assign(new Error('fixture restoration append failed'), { code });
    }
    return Reflect.apply(write, fs, args);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => session.record([{ role: 'tool', text: 'APPEND' }]), /recovery artifact/);
    assert.equal(edited && failed, true);
    const failedHead = fs.readFileSync(paths.head, 'utf8');
    assert.throws(() => session.record([{ role: 'tool', text: 'LATER' }]), /close and reopen/);
    assert.equal(fs.readFileSync(paths.head, 'utf8'), failedHead, 'same-facade retry cannot strand the predecessor under an older HEAD');
  } finally { renameSpy.mock.restore(); writeSpy.mock.restore(); syncBuiltinESMExports(); session.close(); }
  const copies = () => fs.readdirSync(dirname(paths.workingContext)).filter(name => name.startsWith(`${basename(paths.workingContext)}.ce-preserved-`));
  assert.equal(copies().length, 1);
  const preserved = join(dirname(paths.workingContext), copies()[0]!);
  assert.equal(fs.readFileSync(preserved, 'utf8'), 'OBSERVED_EDIT');
  assert.equal(fs.statSync(preserved).mode & 0o777, 0o600);
  const reopened = openSession(options);
  assert.equal(reopened.status, 'open');
  try {
    assert.equal(reopened.session.sync().receipt?.kind, 'restored');
    assert.match(fs.readFileSync(paths.events, 'utf8'), /OBSERVED_EDIT/);
    assert.deepEqual(copies(), []);
    assert.match(fs.readFileSync(paths.workingContext, 'utf8'), /APPEND/);
  } finally { reopened.session.close(); }
});

test('preservation failure refuses before replacing the Working Context', t => {
  const { session, paths } = seeded();
  const before = fs.readFileSync(paths.workingContext, 'utf8'), link = fs.linkSync;
  const spy = t.mock.method(fs, 'linkSync', (from: PathLike, to: PathLike) => {
    if (String(to).includes('.ce-preserved-')) throw Object.assign(new Error('fixture reservation failed'), { code: 'ENOSPC' });
    return link(from, to);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => session.record([{ role: 'tool', text: 'APPEND' }]), /fixture reservation failed/);
    assert.equal(fs.readFileSync(paths.workingContext, 'utf8'), before);
  } finally { spy.mock.restore(); syncBuiltinESMExports(); session.close(); }
});

test('retry verifies and retires the two-name predecessor left before rename', t => {
  const { options, session, paths } = seeded();
  const before = fs.readFileSync(paths.workingContext, 'utf8'), rename = fs.renameSync;
  const spy = t.mock.method(fs, 'renameSync', (from: PathLike, to: PathLike) => {
    if (String(to).endsWith('/context.md')) throw Object.assign(new Error('fixture rename failed'), { code: 'EIO' });
    return rename(from, to);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => session.record([{ role: 'tool', text: 'APPEND' }]), /recovery artifact/);
    assert.equal(fs.readFileSync(paths.workingContext, 'utf8'), before);
    assert.equal(fs.statSync(paths.workingContext).nlink, 2);
  } finally { spy.mock.restore(); syncBuiltinESMExports(); session.close(); }
  const reopened = openSession(options);
  assert.equal(reopened.status, 'open');
  try {
    assert.match(reopened.session.sync().workingContextText, /APPEND/);
    assert.equal(fs.statSync(paths.workingContext).nlink, 1);
    assert.deepEqual(fs.readdirSync(dirname(paths.workingContext)).filter(name => name.includes('.ce-preserved-')), []);
  } finally { reopened.session.close(); }
});

for (const kind of ['symlink', 'unrelated hard link', 'nonprivate']) test(`recovery refuses a ${kind} artifact before reading its payload`, t => {
  const { options, session, paths } = seeded();
  session.close();
  const head = JSON.parse(fs.readFileSync(paths.head, 'utf8'));
  head.materialized = false;
  fs.writeFileSync(paths.head, JSON.stringify(head));
  const preserved = `${paths.workingContext}.ce-preserved-${head.sha}.bak`;
  const victim = join(options.projectRoot, 'private-canary');
  fs.writeFileSync(victim, 'UNREAD_CANARY', { mode: 0o600 });
  if (kind === 'symlink') fs.symlinkSync(victim, preserved);
  else if (kind === 'unrelated hard link') fs.linkSync(victim, preserved);
  else fs.writeFileSync(preserved, 'UNREAD_CANARY', { mode: 0o644 });
  const watched = fs.statSync(kind === 'nonprivate' ? preserved : victim);
  const native = fs.readSync;
  let payloadReads = 0;
  const spy = t.mock.method(fs, 'readSync', (...args: unknown[]) => {
    const fd = args[0];
    if (typeof fd === 'number') {
      const st = fs.fstatSync(fd);
      if (st.dev === watched.dev && st.ino === watched.ino) payloadReads++;
    }
    return Reflect.apply(native, fs, args);
  });
  syncBuiltinESMExports();
  try { assert.throws(() => openSession(options), /recovery artifact/); }
  finally { spy.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(payloadReads, 0);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'UNREAD_CANARY');
  assert.ok(fs.lstatSync(preserved));
  assert.doesNotMatch(fs.readFileSync(paths.events, 'utf8'), /UNREAD_CANARY/);
});
