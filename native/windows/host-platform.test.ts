import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join, resolve } from 'node:path';
import { createWindowsPlatform } from '../../core/platform-windows.ts';
const root = resolve(process.argv[2]!);
assert.match(root, /\\windows-native-20261102\\fixtures$/);
const host = createWindowsPlatform();
const directory = join(root, `host-${process.pid}-${Date.now()}`);
host.mkdirPrivateSync(directory);
const parent = host.openSync(directory, 'directory');
try {
  await test('HostPlatform writes, reads, observes, links and flushes exact bytes', () => {
    const file = host.child(host.anchor(parent), 'a');
    host.writeFileSync(file, 'native adapter');
    assert.equal(host.readFileSync(file).toString(), 'native adapter');
    assert.match(String(host.lstatSync(file).ino), /^win32-file:[0-9a-f]{32}$/);
    const observation = host.observeFileSync(file);
    assert.equal(observation.size, 14); assert.match(observation.mtime, /^win32-filetime:[0-9]+$/);
    const linked = host.child(host.anchor(parent), 'b');
    host.linkSync(file, linked);
    assert.equal(host.lstatSync(file).ino, host.lstatSync(linked).ino);
    host.unlinkSync(linked); host.fsyncSync(parent);
  });
  await test('two directory cursors hold independent enumeration positions', () => {
    host.writeFileSync(host.child(host.anchor(parent), 'b'), 'second');
    host.writeFileSync(host.child(host.anchor(parent), 'c'), 'third');
    const one = host.opendirSync(host.anchor(parent));
    const two = host.opendirSync(host.anchor(parent));
    try {
      const a: string[] = [], b: string[] = [];
      for (let i = 0; i < 4; i++) { const x = one.readSync(), y = two.readSync(); if (x) a.push(x.name); if (y) b.push(y.name); }
      assert.deepEqual(a.sort(), ['a', 'b', 'c']); assert.deepEqual(b.sort(), ['a', 'b', 'c']);
    } finally { one.closeSync(); two.closeSync(); }
    assert.throws(() => one.readSync(), { code: 'ERR_DIR_CLOSED' });
  });
  await test('an opened directory reference survives replacement of its old name', () => {
    const moved = directory + '-moved';
    host.renameSync(directory, moved); host.mkdirPrivateSync(directory);
    host.writeFileSync(join(directory, 'a'), 'replacement');
    assert.equal(host.readFileSync(host.child(host.anchor(parent), 'a')).toString(), 'native adapter');
    assert.equal(host.readFileSync(join(directory, 'a')).toString(), 'replacement');
    assert.equal(host.openedPath(parent), moved);
    host.fsyncSync(parent);
  });
  await test('invalid nested names refuse before a recursive prefix is created', () => {
    const prefix = join(directory, 'absent-prefix');
    assert.throws(() => host.mkdirPrivateSync(join(prefix, 'CON'), { recursive: true }), { code: 'EINVAL' });
    assert.equal(host.existsSync(prefix), false);
  });
} finally { host.closeSync(parent); }
console.log(JSON.stringify({ fixture: directory, nativeHostAdapter: true, fixturesRetained: true }));
