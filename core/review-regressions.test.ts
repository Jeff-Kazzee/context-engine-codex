import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, tempDir } from './testing.ts';
import { openSession, setParticipation, participation } from './index.ts';
import { layout, projectKey } from './store.ts';
import { checkRefs } from './refs.ts';
import { setProcFdDir } from './faults.ts';

const opts = (f: ReturnType<typeof fixture>) => ({ ...f, sessionId: 'S1', runner: 'test', hardLimit: 10000 });

test('self-ignore rejects dangling and live links without reading or changing the target', () => {
  for (const live of [false, true]) {
    const f = fixture();
    const outside = join(tempDir('outside-ignore'), 'target');
    if (live) writeFileSync(outside, 'outside unchanged');
    mkdirSync(join(f.projectRoot, '.context-engine'));
    symlinkSync(outside, join(f.projectRoot, '.context-engine', '.gitignore'));
    assert.throws(() => openSession(opts(f)), /gitignore/);
    assert.equal(existsSync(outside), live);
    if (live) assert.equal(readFileSync(outside, 'utf8'), 'outside unchanged');
  }
});

test('self-ignore refuses insufficient or negated existing rules without replacing them', () => {
  // An empty file is what a first open killed before its write leaves, and it is repaired instead
  // (the CORE-001 test in process-crash.test.ts).
  for (const contents of ['*.tmp\n', '*\n!S1/\n']) {
    const f = fixture();
    mkdirSync(join(f.projectRoot, '.context-engine'));
    const path = join(f.projectRoot, '.context-engine', '.gitignore');
    writeFileSync(path, contents);
    assert.throws(() => openSession(opts(f)), /gitignore/);
    assert.equal(readFileSync(path, 'utf8'), contents);
  }
});

test('self-ignore also refuses a link to a regular ignore file inside the project', () => {
  const f = fixture();
  const target = join(f.projectRoot, 'owned-ignore');
  writeFileSync(target, '*\n');
  mkdirSync(join(f.projectRoot, '.context-engine'));
  symlinkSync(target, join(f.projectRoot, '.context-engine', '.gitignore'));
  assert.throws(() => openSession(opts(f)), /gitignore/);
  assert.equal(readFileSync(target, 'utf8'), '*\n');
});

test('fresh recovery failure releases its lock so a repaired session can retry', () => {
  const f = fixture();
  const l = layout(f.projectRoot, 'S1', f.stateDir);
  mkdirSync(l.stateDir, { recursive: true });
  writeFileSync(l.head, JSON.stringify({ rev: 1, sha: 'missing', parent: null, through: 0, materialized: true }));
  assert.throws(() => openSession(opts(f)));
  assert.equal(existsSync(l.lock), false);
});

test('failed same-owner recovery preserves the original live lock', () => {
  const f = fixture();
  const first = openSession(opts(f));
  assert.equal(first.status, 'open');
  const l = layout(f.projectRoot, 'S1', f.stateDir);
  writeFileSync(l.head, JSON.stringify({ rev: 1, sha: 'missing', parent: null, through: 0, materialized: true }));
  try { assert.throws(() => openSession(opts(f))); assert.equal(existsSync(l.lock), true); }
  finally { first.session.close(); }
});

test('project identity uses the full digest and rejects a mismatched participation record', () => {
  const f = fixture();
  assert.match(projectKey(f.projectRoot), /-[a-f0-9]{64}$/);
  setParticipation({ ...f, state: 'on' });
  const path = join(f.stateDir, 'participation', `${projectKey(f.projectRoot)}.json`);
  writeFileSync(path, JSON.stringify({ projectRoot: '/different/project', state: 'on' }));
  assert.equal(participation({ ...f, env: {} }).active, false);
});

test('unavailable fd verification is not reported as a missing cited file', () => {
  const f = fixture();
  writeFileSync(join(f.projectRoot, 'source.ts'), 'exists');
  setProcFdDir('/not-a-proc-fd-directory');
  try { assert.equal(checkRefs(f.projectRoot, '⟦src:source.ts@00000000⟧'), undefined); }
  finally { setProcFdDir(null); }
  assert.equal(checkRefs(f.projectRoot, '⟦src:absent.ts@00000000⟧')?.refs[0]?.reason, 'missing');
});
