import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validFileIdentity } from './file-identity.ts';

test('persisted Linux identity retains its exact version-one numeric representation', () => {
  const record = { version: 1, sha: 'unchanged', dev: 2049, ino: 246, stage: 'linked' };
  const serialized = JSON.stringify(record);
  assert.equal(validFileIdentity(JSON.parse(serialized)), true);
  assert.equal(serialized, '{"version":1,"sha":"unchanged","dev":2049,"ino":246,"stage":"linked"}');
});

test('Windows full identities survive JSON without numeric truncation', () => {
  const id = { dev: 'win32-volume:0123456789abcdef', ino: 'win32-file:0123456789abcdef0123456789abcdef' };
  assert.equal(validFileIdentity(id), true);
  assert.deepEqual(JSON.parse(JSON.stringify(id)), id);
  assert.notEqual(id.ino, { ...id, ino: id.ino.slice(0, -1) + '0' }.ino);
});

test('mixed, unsafe and malformed identities refuse rather than fall back', () => {
  for (const value of [null, {}, { dev: 1, ino: 0 }, { dev: 1, ino: 2 ** 54 },
    { dev: 1, ino: 'win32-file:' + '0'.repeat(32) },
    { dev: 'win32-volume:' + '0'.repeat(16), ino: 1 },
    { dev: 'win32-volume:' + '0'.repeat(16), ino: 'win32-file:1234' },
    { dev: 'win32-volume:' + 'A'.repeat(16), ino: 'win32-file:' + '0'.repeat(32) }]) {
    assert.equal(validFileIdentity(value), false);
  }
});
