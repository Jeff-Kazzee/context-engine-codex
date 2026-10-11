import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tempDir } from '../core/testing.ts';
import { completeLedger, revert, takeSnapshot } from './ledger.ts';

test('wave52: a vanished owned file is not claimed as an empty artifact', () => {
  const root = tempDir('ledger'), watch = join(root, 'watch'), backupRoot = join(root, 'backups');
  fs.mkdirSync(watch);
  const owned = join(watch, 'owned.txt');
  const snapshot = takeSnapshot({ backupRoot, kind: 'test', files: [], watch: [watch], namespaced: [watch] });
  fs.writeFileSync(owned, 'CREATED');
  const native = fs.openSync;
  let vanished = false;
  fs.openSync = ((path: fs.PathLike, ...args: unknown[]) => {
    if (!vanished && String(path) === owned) { vanished = true; fs.unlinkSync(owned); }
    return Reflect.apply(native, fs, [path, ...args]) as number;
  }) as typeof fs.openSync;
  syncBuiltinESMExports();
  let ledger;
  try { ledger = completeLedger(snapshot); }
  finally { fs.openSync = native; syncBuiltinESMExports(); }
  assert.equal(vanished, true);
  assert.deepEqual(ledger.createdFiles, []);
  fs.writeFileSync(owned, '');
  revert(ledger, {}, {});
  assert.equal(fs.existsSync(owned), true);
});

test('wave52: a rejected snapshot inventory leaves no copied configuration', () => {
  const root = tempDir('snapshot'), watch = join(root, 'watch'), backupRoot = join(root, 'backups'), config = join(root, 'config.json');
  fs.mkdirSync(watch);
  let directory = watch;
  for (let i = 0; i < 66; i++) { directory = join(directory, 'd'); fs.mkdirSync(directory); }
  fs.writeFileSync(config, '{"theme":"original"}');
  assert.throws(() => takeSnapshot({ backupRoot, kind: 'test', files: [config], watch: [watch], namespaced: [] }), /inventory/);
  assert.deepEqual(fs.existsSync(backupRoot) ? fs.readdirSync(backupRoot) : [], []);
  assert.equal(fs.readFileSync(config, 'utf8'), '{"theme":"original"}');
});

test('wave52: a partial later backup write cleans its copies before setup mutation', () => {
  const root = tempDir('snapshot'), backupRoot = join(root, 'backups'), first = join(root, 'first.json'), second = join(root, 'second.json');
  fs.writeFileSync(first, '{"theme":"first"}');
  fs.writeFileSync(second, '{"theme":"second"}');
  const native = fs.writeFileSync;
  let failed = false;
  fs.writeFileSync = ((path: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, ...args: unknown[]) => {
    if (!failed && typeof path === 'number' && fs.realpathSync(`/proc/self/fd/${path}`).endsWith('/before/1-second.json')) {
      failed = true;
      native(path, 'PART');
      throw new Error('fixture partial backup failure');
    }
    Reflect.apply(native, fs, [path, data, ...args]);
  }) as typeof fs.writeFileSync;
  syncBuiltinESMExports();
  try { assert.throws(() => takeSnapshot({ backupRoot, kind: 'test', files: [first, second], watch: [], namespaced: [] }), /fixture partial backup/); }
  finally { fs.writeFileSync = native; syncBuiltinESMExports(); }
  assert.equal(failed, true);
  assert.deepEqual(fs.readdirSync(backupRoot), []);
  assert.equal(fs.readFileSync(first, 'utf8'), '{"theme":"first"}');
  assert.equal(fs.readFileSync(second, 'utf8'), '{"theme":"second"}');
});

test('wave52: successful snapshots still preserve byte-exact before copies', () => {
  const root = tempDir('snapshot'), config = join(root, 'config.json');
  const original = Buffer.from('{"theme":"original"}\r\n');
  fs.writeFileSync(config, original);
  const snapshot = takeSnapshot({ backupRoot: join(root, 'backups'), kind: 'test', files: [config], watch: [], namespaced: [] });
  assert.deepEqual(fs.readFileSync(snapshot.files[0]!.before!), original);
});
