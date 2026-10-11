// Synthetic local filesystem regressions; never use real runner homes or captures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { fixture, tempDir } from './testing.ts';
import { openSession, setParticipation, participation } from './index.ts';
import { appendLog, projectKey } from './store.ts';
import { createHash } from 'node:crypto';

for (const phase of ['before-parent-open', 'before-temp', 'before-rename']) test(`Working Context writes stay confined after parent swap ${phase}`, () => {
  const f = fixture();
  const r = openSession({ ...f, sessionId: 'S1', runner: 'test', hardLimit: 100000 });
  assert.equal(r.status, 'open');
  const s = r.session;
  const parent = dirname(s.workingContextPath), moved = `${parent}-moved`;
  const external = tempDir('external');
  const victim = join(external, 'context.md');
  fs.writeFileSync(victim, 'SYNTHETIC_EXTERNAL_UNCHANGED');
  const nativeOpen = fs.openSync, nativeRename = fs.renameSync;
  let swapped = false;
  const swap = () => { if (!swapped) { swapped = true; fs.renameSync(parent, moved); fs.symlinkSync(external, parent); } };
  try {
    fs.openSync = ((path: any, ...args: any[]) => {
      const name = String(path);
      if (phase === 'before-parent-open' && (name === parent || name.startsWith(`${s.workingContextPath}.ce-`))) swap();
      if (phase === 'before-temp' && name.includes('/context.md.ce-')) swap();
      return (nativeOpen as any)(path, ...args);
    }) as typeof fs.openSync;
    fs.renameSync = ((from: any, to: any) => {
      if (phase === 'before-rename' && String(to).endsWith('/context.md')) swap();
      return nativeRename(from, to);
    }) as typeof fs.renameSync;
    syncBuiltinESMExports();
    try { s.record([{ role: 'user', text: 'SYNTHETIC_NEW_CONTEXT' }]); } catch { /* Refusal is safe; outside writes are not. */ }
    assert.ok(swapped, 'the intended race must be exercised');
    assert.equal(fs.readFileSync(victim, 'utf8'), 'SYNTHETIC_EXTERNAL_UNCHANGED');
    assert.deepEqual(fs.readdirSync(external), ['context.md'], 'no outside temporary file');
  } finally {
    fs.openSync = nativeOpen; fs.renameSync = nativeRename; syncBuiltinESMExports();
    if (swapped) { fs.unlinkSync(parent); fs.renameSync(moved, parent); }
    s.close();
  }
});

for (const length of [185, 186, 191, 255]) test(`long project basename ${length} retains digest and fits all managed filenames`, () => {
  const root = tempDir('long-name');
  const projectRoot = join(root, 'p'.repeat(length));
  fs.mkdirSync(projectRoot);
  const stateDir = join(tempDir('state'), 'context-engine');
  const key = projectKey(projectRoot);
  assert.match(key, /-[a-f0-9]{64}$/);
  assert.ok(Buffer.byteLength(key) <= 255);
  setParticipation({ projectRoot, stateDir, state: 'on' });
  assert.equal(participation({ projectRoot, stateDir, env: {} }).active, true);
  const r = openSession({ projectRoot, stateDir, sessionId: 'S1', runner: 'test', hardLimit: 100000 });
  assert.equal(r.status, 'open'); r.session.close();
});

test('existing long project keys retain opt-outs and session history', () => {
  const root = tempDir('legacy-key'), projectRoot = join(root, 'p'.repeat(185));
  fs.mkdirSync(projectRoot);
  const stateDir = join(tempDir('state'), 'context-engine');
  setParticipation({ projectRoot: root, stateDir, state: 'on' });
  const legacyKey = `${'p'.repeat(185)}-${createHash('sha256').update(fs.realpathSync(projectRoot)).digest('hex')}`;
  fs.writeFileSync(join(stateDir, 'participation', `${legacyKey}.json`), JSON.stringify({ projectRoot: fs.realpathSync(projectRoot), state: 'off' }), {mode: 0o600});
  assert.equal(projectKey(projectRoot), legacyKey);
  assert.equal(participation({ projectRoot, stateDir, env: {} }).active, false);
  const opts = { projectRoot, stateDir, sessionId: 'S1', runner: 'test', hardLimit: 100000 };
  const first = openSession(opts); assert.equal(first.status, 'open');
  first.session.record([{ role: 'user', text: 'LEGACY_SESSION_PRESERVED' }]); first.session.close();
  const next = openSession(opts); assert.equal(next.status, 'open');
  assert.equal(next.session.stateDir, join(stateDir, legacyKey, 'S1'));
  assert.ok(fs.readFileSync(next.session.workingContextPath, 'utf8').includes('LEGACY_SESSION_PRESERVED'));
  next.session.close();
});


test('warm reopen avoids historical payload reads; changed budget and invalid cache rebuild', () => {
  const f = fixture();
  const opts = { ...f, sessionId: 'S1', runner: 'test', hardLimit: 100000, budgetTokens: 10000 };
  const first = openSession(opts); assert.equal(first.status, 'open');
  first.session.record([{ role: 'tool', text: 'x'.repeat(20000) }]); first.session.close();
  const state = first.session.stateDir, log = join(state, 'events.jsonl'), cache = join(state, 'recovery.json');
  const nativeRead = fs.readFileSync,nativeChunk=fs.readSync;
  let fullReads = 0,historyReads=0;
  try {
    fs.readFileSync = ((path: any, ...args: any[]) => {
      if (path === log) fullReads++;
      return (nativeRead as any)(path, ...args);
    }) as typeof fs.readFileSync;
    fs.readSync=((fd:number,...args:any[])=>{if(fs.readlinkSync('/proc/self/fd/'+fd)===log && args[0]?.length===65536)historyReads++;return (nativeChunk as any)(fd,...args);}) as typeof fs.readSync;
    syncBuiltinESMExports();
    for (let i = 0; i < 8; i++) {
      const r = openSession(opts); assert.equal(r.status, 'open');
      r.session.record([{ role: 'user', text: `small ${i}` }]); r.session.close();
    }
    assert.equal(fullReads, 0, 'no whole-log read');assert.equal(historyReads,0,'growing normal hooks reuse their fully applied checkpoint');
    const changed = openSession({ ...opts, budgetTokens: 9999 }); assert.equal(changed.status, 'open'); changed.session.sync(); changed.session.close();
    assert.ok(historyReads>0,'budget change scans reminder history');const afterBudget=historyReads;
    const c = JSON.parse(fs.readFileSync(cache, 'utf8')); c.memory.lastTokens++;
    fs.writeFileSync(cache, JSON.stringify(c));
    const corrupt = openSession({ ...opts, budgetTokens: 9999 }); assert.equal(corrupt.status, 'open'); corrupt.session.sync(); corrupt.session.close();
    assert.ok(historyReads>afterBudget,'checksum mismatch rebuilds rather than trusting corrupted memory');const afterCorrupt=historyReads;
    fs.unlinkSync(cache);
    const missing = openSession(opts); assert.equal(missing.status, 'open'); missing.session.sync(); missing.session.close();
    assert.ok(historyReads>afterCorrupt,'legacy/missing cache uses full recovery');assert.equal(fullReads,0,'rebuilds stream without whole-log allocation');
  } finally { fs.readFileSync = nativeRead; fs.readSync=nativeChunk; syncBuiltinESMExports(); }
});

test('log changes invalidate recovery cache and replay unapplied events without sequence reuse', () => {
  const f = fixture(), opts = { ...f, sessionId: 'S1', runner: 'test', hardLimit: 100000 };
  const first = openSession(opts); assert.equal(first.status, 'open');
  first.session.record([{ role: 'user', text: 'FIRST' }]); first.session.close();
  const cache = JSON.parse(fs.readFileSync(join(first.session.stateDir, 'recovery.json'), 'utf8'));
  appendLog(join(first.session.stateDir, 'events.jsonl'), { type: 'runner-events', events: [{ seq: cache.lastSeq + 1, event: { role: 'user', text: 'PENDING_REPLAY' } }] });
  const reopened = openSession(opts); assert.equal(reopened.status, 'open');
  reopened.session.record([{ role: 'user', text: 'NEXT_UNIQUE_SEQUENCE' }]); reopened.session.close();
  const text = fs.readFileSync(reopened.session.workingContextPath, 'utf8');
  assert.ok(text.indexOf('FIRST') < text.indexOf('PENDING_REPLAY'));
  assert.ok(text.indexOf('PENDING_REPLAY') < text.indexOf('NEXT_UNIQUE_SEQUENCE'));
  assert.equal(text.split('PENDING_REPLAY').length - 1, 1);
  const final = JSON.parse(fs.readFileSync(join(reopened.session.stateDir, 'recovery.json'), 'utf8'));
  assert.equal(final.lastSeq, cache.lastSeq + 2);
});
