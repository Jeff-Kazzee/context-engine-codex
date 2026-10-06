import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { cite, openSession, readWorkingContext, setParticipation, participation } from './index.ts';
import { resolveStateRoot } from './store.ts';
import { fixture, tempDir } from './testing.ts';

test('relative explicit and environment state roots refuse before any state write', () => {
  assert.throws(() => resolveStateRoot('.state'), /absolute/);
  const previous = process.env.CONTEXT_ENGINE_STATE_DIR;
  try { process.env.CONTEXT_ENGINE_STATE_DIR = '.state'; assert.throws(() => resolveStateRoot(), /absolute/); }
  finally { if (previous === undefined) delete process.env.CONTEXT_ENGINE_STATE_DIR; else process.env.CONTEXT_ENGINE_STATE_DIR = previous; }
  const absolute = resolve(tempDir('state')); assert.equal(resolveStateRoot(absolute), absolute);
});

for (const name of ['.env', '.env.production', '.npmrc', '.pypirc', '.aws/credentials', '.ssh/id_ed25519', '.gnupg/private-keys-v1.d/key', '.codex/auth.json', '.claude/.credentials.json']) test(`cite refuses synthetic project credential location ${name} before reading`, () => {
  const f = fixture(), path = join(f.projectRoot, name);
  fs.mkdirSync(dirname(path), { recursive: true }); fs.writeFileSync(path, 'SYNTHETIC_ONLY');
  const native = fs.readFileSync; let read = false;
  try {
    fs.readFileSync = ((fd: any, ...args: any[]) => {
      if (typeof fd === 'number' && fs.realpathSync(`/proc/self/fd/${fd}`) === path) read = true;
      return (native as any)(fd, ...args);
    }) as typeof fs.readFileSync; syncBuiltinESMExports();
    assert.throws(() => cite(f.projectRoot, name), /credential/); assert.equal(read, false);
  } finally { fs.readFileSync = native; syncBuiltinESMExports(); }
});

test('multipart read requires its first content digest and refuses a changed file', () => {
  const f = fixture(), opened = openSession({ ...f, sessionId: 'S1', runner: 'test', hardLimit: 200000 });
  assert.equal(opened.status, 'open');
  try {
    opened.session.record([{ role: 'user', text: 'A'.repeat(40000) }]);
    const first = readWorkingContext({ ...f, sessionId: 'S1' }); assert.equal(first.parts, 2);
    assert.match(first.sha, /^[a-f0-9]{64}$/);
    assert.throws(() => readWorkingContext({ ...f, sessionId: 'S1', part: 2 }), /digest|sha/);
    assert.equal(readWorkingContext({ ...f, sessionId: 'S1', part: 2, sha: first.sha }).part, 2);
    const path = opened.session.workingContextPath;
    fs.writeFileSync(path, fs.readFileSync(path, 'utf8').replaceAll('A', 'B'));
    assert.throws(() => readWorkingContext({ ...f, sessionId: 'S1', part: 2, sha: first.sha }), /changed.*restart/i);
  } finally { opened.session.close(); }
});

test('same-process interleaved participation writes use unique exclusive temporaries', () => {
  const f = fixture(), native = fs.writeFileSync; const paths: string[] = []; let inner = false;
  try {
    fs.writeFileSync = ((path: any, data: any, options: any) => {
      if (String(path).endsWith('.tmp')) {
        paths.push(String(path)); assert.equal(options.flag, 'wx');
        native(path, data, options);
        if (!inner) { inner = true; setParticipation({ ...f, state: 'off' }); }
        return;
      }
      return native(path, data, options);
    }) as typeof fs.writeFileSync; syncBuiltinESMExports();
    setParticipation({ ...f, state: 'on' });
    assert.equal(new Set(paths).size, 2); assert.equal(participation({ ...f, env: {} }).state, 'on');
  } finally { fs.writeFileSync = native; syncBuiltinESMExports(); }
});
