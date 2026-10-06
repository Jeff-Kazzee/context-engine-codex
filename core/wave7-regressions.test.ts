import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { basename, join } from 'node:path';
import { ensureDirs, layout, removeTemps, removeDirectoryEntries } from './store.ts';
import { fixture, tempDir } from './testing.ts';
import { checkRefs, cite } from './refs.ts';
import { setConfineHook } from './faults.ts';

test('wave7: foreign managed owner refuses before subtree writes', () => {
  const f = fixture(), l = layout(f.projectRoot, 'S1', f.stateDir), managed = join(f.projectRoot, '.context-engine');
  fs.mkdirSync(managed, { mode: 0o777 });
  const original = fs.fstatSync;
  fs.fstatSync = ((fd: number, ...args: unknown[]) => {
    const st = original(fd, ...args as []);
    if (fs.readlinkSync(`/proc/self/fd/${fd}`) === managed) return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { uid: process.getuid!() + 1 });
    return st;
  }) as typeof fs.fstatSync;
  syncBuiltinESMExports();
  try { assert.throws(() => ensureDirs(l, f.stateDir), /owned|ownership/); }
  finally { fs.fstatSync = original; syncBuiltinESMExports(); }
  assert.deepEqual(fs.readdirSync(managed), [], 'no session or ignore file before ownership refusal');
});

test('wave7: owned managed directory permission migration still succeeds', () => {
  const f = fixture(), l = layout(f.projectRoot, 'S1', f.stateDir), managed = join(f.projectRoot, '.context-engine');
  fs.mkdirSync(managed, { mode: 0o755 }); ensureDirs(l, f.stateDir);
  assert.equal(fs.statSync(managed).mode & 0o777, 0o700);
  assert.equal(fs.readFileSync(join(managed, '.gitignore'), 'utf8').trim().split('\n').at(-1), '*');
});

for (const file of ['orphan.tmp', '2.md']) test('wave7: cleanup stays on its verified parent during a swap: ' + file, () => {
  const dir = tempDir('cleanup'), outside = tempDir('outside');
  fs.writeFileSync(join(dir, file), 'own'); fs.writeFileSync(join(outside, file), 'external');
  const original = fs.lstatSync;
  let swapped = false;
  Object.defineProperty(fs, 'lstatSync', { value: ((path: fs.PathLike, ...args: unknown[]) => {
    const st = original(path, ...args as []);
    if (!swapped && basename(String(path)) === file) {
      swapped = true; fs.renameSync(dir, `${dir}-held`); fs.symlinkSync(outside, dir);
    }
    return st;
  }) as typeof fs.lstatSync });
  syncBuiltinESMExports();
  try { if (file.endsWith('.tmp')) removeTemps([dir], []); else removeDirectoryEntries(dir, name => name === '2.md'); }
  finally { Object.defineProperty(fs, 'lstatSync', { value: original }); syncBuiltinESMExports(); }
  assert.equal(swapped, true);
  assert.equal(fs.readFileSync(join(outside, file), 'utf8'), 'external');
  assert.equal(fs.existsSync(join(`${dir}-held`, file)), false);
});

test('wave7: cleanup removes ordinary orphan and leaves unrelated entries', () => {
  const dir = tempDir('cleanup');
  for (const name of ['1.md', '2.md', 'keep.txt']) fs.writeFileSync(join(dir, name), name);
  removeDirectoryEntries(dir, name => /^(\d+)\.md$/.test(name) && Number(name.split('.')[0]) > 1);
  assert.deepEqual(fs.readdirSync(dir), ['1.md', 'keep.txt']);
});

test('wave7: relocation work exhaustion reports changed without partial nearest claim', () => {
  const project = tempDir('refs'), path = join(project, 'large.txt');
  const lines = Array.from({ length: 32 }, (_, i) => `${i}:` + 'x'.repeat(8192));
  fs.writeFileSync(path, lines.join('\n'));
  const marker = cite(project, 'large.txt#L1-16');
  fs.writeFileSync(path, ['inserted', ...lines].join('\n'));
  assert.equal(checkRefs(project, marker)?.refs[0]?.reason, 'changed');
});

test('wave7: reversed marker range reports changed on tiny input', () => {
  const project = tempDir('refs'); fs.writeFileSync(join(project, 'small.txt'), 'one\ntwo');
  assert.equal(checkRefs(project, '⟦src:small.txt#L4-1@00000000⟧')?.refs[0]?.reason, 'changed');
  assert.throws(() => cite(project, 'small.txt#L9007199254740993-9007199254740993'), /lines|range/);
});

test('wave7: invalid line ranges refuse before source reads', () => {
  const project = tempDir('refs'); fs.writeFileSync(join(project, 'small.txt'), 'one\ntwo');
  let opens = 0; setConfineHook(() => { opens++; });
  try {
    for (const range of ['0-1', '4-1', '100000000000000000000-1']) {
      assert.equal(checkRefs(project, `⟦src:small.txt#L${range}@00000000⟧`)?.refs[0]?.reason, 'changed');
      assert.throws(() => cite(project, `small.txt#L${range}`), /range/);
    }
    assert.equal(opens, 0);
  } finally { setConfineHook(null); }
});

test('wave7: relocation candidate exhaustion cannot claim a partially searched match', () => {
  const project = tempDir('refs'), path = join(project, 'small.txt'); fs.writeFileSync(path, 'needle');
  const marker = cite(project, 'small.txt#L1');
  fs.writeFileSync(path, ['shift', 'needle', ...Array(4200).fill('x')].join('\n'));
  assert.equal(checkRefs(project, marker)?.refs[0]?.reason, 'changed');
});
