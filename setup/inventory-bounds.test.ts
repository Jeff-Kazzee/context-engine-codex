import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tempDir } from '../core/testing.ts';
import { completeLedger, revert, takeSnapshot } from './ledger.ts';

const INVENTORY = /inventory exceeds entry, depth or path-byte limit/;

/** A tree under `root`: 15 nested 200-character directories with `files` 200-character files at the bottom. */
function longNames(root: string, files: number): void {
  let dir = root;
  for (let level = 0; level < 15; level++) dir = join(dir, `${String(level).padStart(2, '0')}${'d'.repeat(198)}`);
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < files; i++) fs.writeFileSync(join(dir, `${String(i).padStart(4, '0')}${'f'.repeat(196)}`), '');
}

test('[PERF-006] path-name byte budget refuses before any backup', () => {
  const root = tempDir('path-bytes');
  const watch = join(root, 'plugins'), backupRoot = join(root, 'backups');
  longNames(watch, 350);
  assert.throws(() => takeSnapshot({ backupRoot, kind: 'synthetic', files: [], watch: [watch], namespaced: [] }), INVENTORY);
  assert.equal(fs.existsSync(backupRoot), false);

  const control = tempDir('path-bytes-control');
  longNames(join(control, 'plugins'), 250);
  assert.doesNotThrow(() => takeSnapshot({ backupRoot: join(control, 'backups'), kind: 'synthetic', files: [], watch: [join(control, 'plugins')], namespaced: [] }));
});

/** Serve `entries` synthetic names from `watch`, each with the stat of `seed`, as the wave13 inventory test does. */
function withSyntheticEntries<T>(watch: string, seed: string, entries: number, action: () => T): T {
  const stat = fs.lstatSync(seed);
  const nativeOpen = fs.opendirSync, nativeStat = fs.lstatSync;
  fs.opendirSync = ((path: any, ...args: any[]) => {
    if (String(path) !== watch) return (nativeOpen as any)(path, ...args);
    let i = 0;
    return { readSync: () => (i < entries ? { name: `entry-${i++}` } : null), closeSync: () => {} };
  }) as typeof fs.opendirSync;
  (fs as any).lstatSync = (path: any, ...args: any[]) => (String(path).startsWith(`${watch}/entry-`) ? stat : (nativeStat as any)(path, ...args));
  syncBuiltinESMExports();
  try { return action(); }
  finally { fs.opendirSync = nativeOpen; (fs as any).lstatSync = nativeStat; syncBuiltinESMExports(); }
}

test('[PERF-006] inventory boundaries accept 4,096 paths and depth 64', () => {
  const root = tempDir('inventory-edges'), watch = join(root, 'plugins'), seed = join(root, 'seed');
  fs.mkdirSync(watch);
  fs.writeFileSync(seed, '');
  const snapshot = (backups: string) => takeSnapshot({ backupRoot: join(root, backups), kind: 'synthetic', files: [], watch: [watch], namespaced: [] });
  assert.equal(withSyntheticEntries(watch, seed, 4095, () => snapshot('accept-paths')).listing.length, 4096);
  assert.throws(() => withSyntheticEntries(watch, seed, 4096, () => snapshot('refuse-paths')), INVENTORY);

  for (const [depth, accepted] of [[64, true], [65, false]] as const) {
    const deep = join(tempDir(`depth-${depth}`), 'plugins');
    fs.mkdirSync(join(deep, ...Array.from({ length: depth }, () => 'd')), { recursive: true });
    const take = () => takeSnapshot({ backupRoot: join(deep, '..', 'backups'), kind: 'synthetic', files: [], watch: [deep], namespaced: [] });
    if (accepted) assert.equal(take().listing.length, depth + 1);
    else assert.throws(take, INVENTORY);
  }
});

test('[PERF-006] namespace cleanup over budget retains the namespace', () => {
  for (const [files, accepted] of [[4096, true], [4097, false]] as const) {
    const root = tempDir(`namespace-${files}`), namespace = join(root, 'cache', 'context-engine');
    const snap = takeSnapshot({ backupRoot: join(root, 'backups'), kind: 'synthetic', files: [], watch: [], namespaced: [namespace] });
    fs.mkdirSync(namespace, { recursive: true });
    for (let i = 0; i < files; i++) fs.writeFileSync(join(namespace, `f${i}`), '');
    const ledger = completeLedger(snap);
    if (accepted) {
      revert(ledger, {}, {});
      assert.equal(fs.existsSync(namespace), false);
    } else {
      assert.throws(() => revert(ledger, {}, {}), /cleanup exceeds inventory limits; retained/);
      assert.equal(fs.readdirSync(namespace).length, files, 'every file remains');
    }
  }
});
