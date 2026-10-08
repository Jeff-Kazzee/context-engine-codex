import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { fixture, tempDir } from './testing.ts';
import { participation, setParticipation } from './index.ts';
import { appendLog } from './store.ts';
import { holderFor } from './lock.ts';
import { setLockStepHook } from './faults.ts';

test('wave9: participation fsyncs file before rename, then directory and state root before returning', () => {
  const f = fixture(), calls: string[] = [], sync = fs.fsyncSync, rename = fs.renameSync;
  fs.fsyncSync = ((fd: number) => {
    const path = fs.readlinkSync(`/proc/self/fd/${fd}`);
    if (path.includes('/participation/')) calls.push('file-sync');
    else if (path === join(f.stateDir, 'participation')) calls.push('directory-sync');
    else if (path === f.stateDir) calls.push('root-sync');
    return sync(fd);
  }) as typeof fs.fsyncSync;
  fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => { calls.push('rename'); return rename(from, to); }) as typeof fs.renameSync;
  syncBuiltinESMExports();
  try { setParticipation({ ...f, state: 'off' }); }
  finally { fs.fsyncSync = sync; fs.renameSync = rename; syncBuiltinESMExports(); }
  assert.deepEqual(calls, ['root-sync', 'file-sync', 'rename', 'directory-sync', 'root-sync']);
  assert.equal(participation({ ...f, env: {} }).state, 'off');
});

test('wave9: failed participation file sync refuses publication and keeps the prior record', () => {
  const f = fixture(); setParticipation({ ...f, state: 'on' });
  const sync = fs.fsyncSync;
  fs.fsyncSync = ((fd: number) => {
    if (fs.readlinkSync(`/proc/self/fd/${fd}`).includes('/participation/')) throw Object.assign(new Error('synthetic sync failure'), { code: 'EIO' });
    return sync(fd);
  }) as typeof fs.fsyncSync;
  syncBuiltinESMExports();
  try { assert.throws(() => setParticipation({ ...f, state: 'off' }), /synthetic sync failure/); }
  finally { fs.fsyncSync = sync; syncBuiltinESMExports(); }
  assert.equal(participation({ ...f, env: {} }).state, 'on');
  assert.equal(fs.readdirSync(join(f.stateDir, 'participation')).some(x => x.endsWith('.tmp')), false);
});

for (const phase of ['directory', 'root']) test('wave9: ' + phase + ' sync failure is reported after publication without claiming rollback', () => {
  const f = fixture(); setParticipation({ ...f, state: 'on' });
  const sync = fs.fsyncSync;
  fs.fsyncSync = ((fd: number) => {
    if (fs.readlinkSync(`/proc/self/fd/${fd}`) === (phase === 'directory' ? join(f.stateDir, 'participation') : f.stateDir)) throw new Error('synthetic directory sync failure');
    return sync(fd);
  }) as typeof fs.fsyncSync; syncBuiltinESMExports();
  try { assert.throws(() => setParticipation({ ...f, state: 'off' }), /synthetic directory sync failure/); }
  finally { fs.fsyncSync = sync; syncBuiltinESMExports(); }
  assert.equal(participation({ ...f, env: {} }).state, 'off');
  assert.equal(fs.readdirSync(join(f.stateDir, 'participation')).some(x => x.endsWith('.tmp')), false);
});

test('wave9: recursive dead append breakers remain anchored after parent replacement', () => {
  const dir = tempDir('dead-log-parent'), held = `${dir}-held`, outside = tempDir('dead-outside'), log = join(dir, 'events.jsonl');
  const dead = holderFor(2147483647, 'synthetic-dead', 0);
  for (const name of ['events.jsonl.append.lock', 'events.jsonl.append.lock.break']) fs.writeFileSync(join(dir, name), JSON.stringify(dead), { mode: 0o600 });
  let swapped = false;
  setLockStepHook(step => { if (step === 'stale-seen' && !swapped) { swapped = true; fs.renameSync(dir, held); fs.symlinkSync(outside, dir); } });
  try { appendLog(log, { type: 'synthetic', text: 'SYNTHETIC_DEAD_BREAK_EVENT' }); }
  finally { setLockStepHook(null); }
  assert.equal(swapped, true); assert.deepEqual(fs.readdirSync(outside), []);
  assert.deepEqual(fs.readdirSync(held), ['events.jsonl']);
  assert.match(fs.readFileSync(join(held, 'events.jsonl'), 'utf8'), /SYNTHETIC_DEAD_BREAK_EVENT/);
});

for (const replacement of ['link', 'directory']) test('wave9: Event Log creation and lease stay on the verified parent after replacement: ' + replacement, () => {
  const dir = tempDir('log-parent'), held = `${dir}-held`, outside = tempDir('outside'), log = join(dir, 'events.jsonl'), link = fs.linkSync;
  let swapped = false;
  fs.linkSync = ((from: fs.PathLike, to: fs.PathLike) => {
    const result = link(from, to);
    if (!swapped && String(to).endsWith('/events.jsonl.append.lock')) {
      swapped = true; fs.renameSync(dir, held);
      if (replacement === 'link') fs.symlinkSync(outside, dir); else fs.mkdirSync(dir, { mode: 0o700 });
    }
    return result;
  }) as typeof fs.linkSync;
  syncBuiltinESMExports();
  let failed: unknown;
  try { appendLog(log, { type: 'synthetic', text: 'SYNTHETIC_ANCHORED_EVENT' }); }
  catch (e) { failed = e; }
  finally { fs.linkSync = link; syncBuiltinESMExports(); }
  assert.equal(swapped, true);
  assert.deepEqual(fs.readdirSync(outside), []);
  if (replacement === 'directory') assert.deepEqual(fs.readdirSync(dir), []);
  assert.equal(fs.existsSync(join(held, 'events.jsonl.append.lock')), false, 'lease is released in its original directory');
  if (!failed) assert.match(fs.readFileSync(join(held, 'events.jsonl'), 'utf8'), /SYNTHETIC_ANCHORED_EVENT/);
});
