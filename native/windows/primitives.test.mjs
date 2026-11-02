import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve, parse } from 'node:path';
import { test } from 'node:test';
import { symlinkSync, existsSync, closeSync as nodeClose, readSync as nodeRead } from 'node:fs';
assert.equal(process.platform, 'win32');
assert.equal(process.arch, 'x64');
const require = createRequire(import.meta.url);
const native = require('./build/ce_windows.node');
assert.equal(native.contractVersion, 1);
const call = native.call;
const fixture = resolve(process.argv[2]);
assert.match(fixture, /\\windows-native-20261102\\fixtures$/);
function openDirectory(path) {
  const root = parse(path).root;
  let fd = call('root', root);
  try {
    for (const name of path.slice(root.length).split('\\').filter(Boolean)) {
      const next = call('open', fd, name, 'directory');
      call('close', fd); fd = next;
    }
    return fd;
  } catch (error) { call('close', fd); throw error; }
}
const base = openDirectory(fixture);
const name = `addon-${process.pid}-${Date.now()}`;
call('mkdir', base, name);
const directory = call('open', base, name, 'directory');
try {
  await test('private creation, exact identities and durable anchored namespaces', () => {
    const dirInfo = call('inspect', directory);
    assert.equal(dirInfo.privateAccess, true); assert.equal(dirInfo.owner, 'current');
    assert.match(dirInfo.dev, /^win32-volume:[a-f0-9]{16}$/);
    assert.match(dirInfo.ino, /^win32-file:[a-f0-9]{32}$/);
    call('flush', directory);
    const file = call('open', directory, 'one.txt', 'exclusive');
    try {
      assert.ok(file > 0x7fffffff);
      assert.throws(() => nodeClose(file), { code: 'ERR_OUT_OF_RANGE' });
      assert.throws(() => nodeRead(file, Buffer.alloc(1), 0, 1, 0), { code: 'ERR_OUT_OF_RANGE' });
      const bytes = Buffer.from('first native entry');
      assert.equal(call('write', file, bytes, 0, bytes.length, null), bytes.length);
      call('flush', file);
      assert.equal(call('inspect', file).privateAccess, true);
    } finally { call('close', file); }
    call('link', directory, 'one.txt', directory, 'two.txt');
    assert.throws(() => call('link', directory, 'one.txt', directory, 'two.txt'), { code: 'EEXIST' });
    const first = call('open', directory, 'one.txt', 'read');
    const second = call('open', directory, 'two.txt', 'read');
    try {
      const a = call('inspect', first), b = call('inspect', second);
      assert.equal(a.ino, b.ino); assert.equal(a.dev, b.dev); assert.equal(a.nlink, 2);
      call('rename', directory, 'two.txt', directory, 'renamed.txt');
      const out = Buffer.alloc(64); const count = call('read', second, out, 0, out.length, 0);
      assert.equal(out.subarray(0, count).toString(), 'first native entry');
      call('unlink', directory, 'renamed.txt');
      assert.equal(call('inspect', first).nlink, 1);
      assert.equal(call('read', second, out, 0, out.length, 0), count);
    } finally { call('close', second); call('close', first); }
    call('flush', directory);
  });
  await test('append, truncate and positioned reads preserve cursor semantics', () => {
    const file = call('open', directory, 'one.txt', 'append-existing');
    try {
      const bytes = Buffer.from(' plus');
      assert.equal(call('write', file, bytes, 0, bytes.length, null), bytes.length);
      call('truncate', file, 5); call('flush', file);
    } finally { call('close', file); }
    const read = call('open', directory, 'one.txt', 'read');
    try {
      const out = Buffer.alloc(64); assert.equal(call('read', read, out, 0, out.length, 0), 5);
      assert.equal(out.subarray(0, 5).toString(), 'first');
      assert.equal(call('read', read, out, 0, out.length, null), 5);
      assert.equal(call('read', read, out, 0, out.length, null), 0);
    } finally { call('close', read); }
  });
  await test('single-character namespace names and replacement retain opened data', () => {
    const old = call('open', directory, 'x', 'exclusive');
    const bytes = Buffer.from('old');
    call('write', old, bytes, 0, bytes.length, null); call('close', old);
    const held = call('open', directory, 'x', 'read');
    try {
      call('link', directory, 'one.txt', directory, 'y');
      call('rename', directory, 'y', directory, 'x');
      const out = Buffer.alloc(8);
      assert.equal(call('read', held, out, 0, out.length, 0), 3);
      assert.equal(out.subarray(0, 3).toString(), 'old');
      const fresh = call('open', directory, 'x', 'read');
      const source = call('open', directory, 'one.txt', 'read');
      try {
        assert.equal(call('inspect', fresh).ino, call('inspect', source).ino);
        assert.equal(call('read', fresh, out, 0, out.length, 0), 5);
        assert.equal(out.subarray(0, 5).toString(), 'first');
      } finally { call('close', source); call('close', fresh); }
      call('unlink', directory, 'x');
    } finally { call('close', held); }
  });
  await test('reserved names, traversal and ADS refuse before creation', () => {
    for (const invalid of ['CON', 'con.txt', 'NUL', 'LPT1', 'COM9', 'COM\u00b9', 'x.', 'x ', '..', 'one.txt:secret', 'a/b', 'a\\b', '\ud800', '\udfff', 'a\ud800b']) {
      assert.throws(() => call('open', directory, invalid, 'exclusive'), { code: 'EINVAL' }, invalid);
    }
    const iterator = call('dup', directory); const names = [];
    try { for (let name; (name = call('next', iterator)) !== null;) names.push(name); }
    finally { call('close', iterator); }
    assert.deepEqual(names.sort(), ['one.txt']);
    assert.throws(() => call('inspect', iterator), { code: 'EBADF' });
  });
  await test('well-formed Unicode names roundtrip through native handles and canonical paths', () => {
    const name = 'evidence-\u00e9-\u{1f600}.txt';
    const file = call('open', directory, name, 'exclusive');
    const bytes = Buffer.from('Unicode bridge');
    try {
      call('write', file, bytes, 0, bytes.length, null);
      assert.ok(call('path', file).endsWith('\\' + name));
    } finally { call('close', file); }
    const read = call('open', directory, name, 'read');
    try {
      const out = Buffer.alloc(bytes.length);
      assert.equal(call('read', read, out, 0, out.length, 0), bytes.length);
      assert.deepEqual(out, bytes);
    } finally { call('close', read); }
    call('unlink', directory, name);
  });
  await test('inspection-only junction descriptors cannot become traversal parents', () => {
    call('mkdir', directory, 'target');
    const where = `${fixture}\\${name}`;
    symlinkSync(`${where}\\target`, `${where}\\junction`, 'junction');
    const inspected = call('open', directory, 'junction', 'inspect');
    try {
      assert.equal(call('inspect', inspected).reparse, true);
      assert.throws(() => call('open', inspected, 'escape', 'exclusive'), { code: 'ELOOP' });
      assert.throws(() => call('mkdir', inspected, 'escape'), { code: 'ELOOP' });
      assert.throws(() => call('next', inspected), { code: 'ELOOP' });
      assert.throws(() => call('rmdir', directory, 'junction'), { code: 'ELOOP' });
      assert.equal(existsSync(`${where}\\target\\escape`), false);
    } finally { call('close', inspected); }
  });
  await test('process marker is exact and current process is alive', () => {
    const status = call('process', process.pid);
    assert.match(status.startMarker, /^win32:[1-9][0-9]+$/);
    assert.equal(status.kind, 'windows-process'); assert.equal(status.alive, true);
    assert.equal(call('process', process.pid).startMarker, status.startMarker);
  });
  await test('private access tightening preserves own file contents', () => {
    const fd = call('open', directory, 'one.txt', 'read');
    try { call('private', fd); assert.equal(call('inspect', fd).privateAccess, true); }
    finally { call('close', fd); }
  });
} finally { call('close', directory); call('close', base); }
assert.equal(call('count'), 0, 'all owned descriptors closed');
console.log(JSON.stringify({ fixture: `${fixture}\\${name}`, dataRetained: true, realProfilesTouched: false }));
