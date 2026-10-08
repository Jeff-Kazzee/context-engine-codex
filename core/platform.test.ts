import { test } from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { approxTokens, openSession, parseTurns, renderTurns, setParticipation } from './index.ts';
import { acquireLock, serialized, type LockHolder } from './lock.ts';
import { openPrivateDirectory, atomicWrite } from './store.ts';
import { anchor, childTarget, closeSync, openSync, fstatSync, lstatSync, restrictPrivateAccess, readFileSync as readTarget, requireSupportedPlatform, UnsupportedPlatformError } from './platform.ts';
import { setProcFdDir } from './faults.ts';
import { install, uninstall } from '../setup/install.ts';
import { safeWrite, withSetupLock } from '../setup/files.ts';
import type { RunnerSpec, SetupContext } from '../setup/runners.ts';

test('pure public context operations work without selecting a host backend', () => {
  const turns = [{ role: 'user' as const, text: 'portable context' }];
  assert.deepEqual(parseTurns(renderTurns(turns)), turns);
  assert.equal(approxTokens(8), 2);
});

test('unsupported host selection has a stable refusal type', () => {
  for (const platform of ['win32', 'darwin'] as const) {
    assert.throws(() => requireSupportedPlatform(platform), (e: unknown) =>
      e instanceof UnsupportedPlatformError && e.code === 'CE_UNSUPPORTED_PLATFORM' && e.platform === platform);
  }
});

function inventory(dir: string): Record<string, string> {
  return Object.fromEntries(readdirSync(dir, { recursive: true, withFileTypes: true })
    .map(e => [join(e.parentPath, e.name).slice(dir.length), e.isFile() ? readFileSync(join(e.parentPath, e.name)).toString('hex') : 'directory']));
}

test('real unsupported hosts refuse state, lock, install and uninstall before any write', { skip: process.platform === 'linux' }, () => {
  const root = mkdtempSync(join(process.env.CONTEXT_ENGINE_TEST_TMP || tmpdir(), 'ce-platform-refusal-'));
  try {
    const projectRoot = join(root, 'project'), stateDir = join(root, 'absent-state'), home = join(root, 'runner');
    mkdirSync(projectRoot); mkdirSync(home);
    writeFileSync(join(home, 'settings.json'), '{"unrelated":"preserve"}\n');
    const ctx: SetupContext = { env: {}, checkout: root, setupDir: join(stateDir, 'setup'), claudeHome: home, codexHome: home };
    const spec: RunnerSpec = { id: 'claude', title: 'Synthetic runner', home, bin: 'must-not-run', files: [join(home, 'settings.json')], watch: [], namespaced: [], rules: {}, install: [['must-not-run']], uninstall: [['must-not-run']], prepare() { assert.fail('setup reached prepare'); } };
    const holder: LockHolder = { pid: process.pid, hostname: hostname(), startMarker: null, runner: 'test', hardLimit: 1000, acquiredAt: new Date().toISOString() };
    const actions = [
      () => openPrivateDirectory(stateDir, { create: true, tighten: true }),
      () => openSession({ projectRoot, stateDir, sessionId: 'S1', runner: 'test', hardLimit: 1000 }),
      () => setParticipation({ projectRoot, stateDir, state: 'on' }),
      () => atomicWrite(join(projectRoot, 'new-file'), 'must-not-write', 'head-tmp'),
      () => acquireLock(join(projectRoot, 'session.lock'), holder),
      () => serialized(join(projectRoot, 'op.lock'), () => assert.fail('lock callback ran')),
      () => safeWrite(join(home, 'settings.json'), 'must-not-replace'),
      () => withSetupLock(join(stateDir, 'setup.lock'), () => assert.fail('setup callback ran')),
      () => install(ctx, spec),
      () => uninstall(ctx, spec),
    ];
    const before = inventory(root);
    for (const action of actions) {
      assert.throws(action, (e: unknown) => e instanceof UnsupportedPlatformError && e.code === 'CE_UNSUPPORTED_PLATFORM');
      assert.deepEqual(inventory(root), before);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Linux opened-directory references survive ancestor replacement', { skip: process.platform !== 'linux' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'ce-platform-anchor-'));
  let fd: number | undefined;
  try {
    const dir = join(root, 'dir'); mkdirSync(dir, { mode: 0o700 });
    writeFileSync(join(dir, 'value'), 'original');
    fd = openSync(dir, 'directory');
    const target = childTarget(anchor(fd), 'value');
    renameSync(dir, join(root, 'moved')); mkdirSync(dir, { mode: 0o700 });
    writeFileSync(join(dir, 'value'), 'replacement');
    assert.equal(readTarget(target).toString(), 'original');
  } finally { if (fd !== undefined) closeSync(fd); rmSync(root, { recursive: true, force: true }); }
});

test('Linux missing descriptor mount refuses creation through the existing fault seam', { skip: process.platform !== 'linux' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'ce-platform-no-proc-'));
  try {
    const before = inventory(root);
    setProcFdDir(join(root, 'missing-descriptors'));
    assert.throws(() => openPrivateDirectory(join(root, 'must-not-create'), { create: true }), /cannot verify|refusing creation/);
    assert.deepEqual(inventory(root), before);
  } finally { setProcFdDir(null); rmSync(root, { recursive: true, force: true }); }
});

test('Linux explicit-dot reference inspects the opened directory instead of its descriptor link', { skip: process.platform !== 'linux' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'ce-platform-dot-'));
  const fd = openSync(root, 'directory');
  try {
    assert.equal(lstatSync(anchor(fd)).isSymbolicLink(), true);
    const opened = fstatSync(fd), target = lstatSync(childTarget(anchor(fd), '.'));
    assert.equal(target.isDirectory(), true);
    assert.equal(target.isSymbolicLink(), false);
    assert.deepEqual([target.dev, target.ino], [opened.dev, opened.ino]);
  } finally { closeSync(fd); rmSync(root, { recursive: true, force: true }); }
});

test('Linux access inspection uses one stat and private access changes the actual handle', { skip: process.platform !== 'linux' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'ce-platform-access-'));
  const file = join(root, 'value'); writeFileSync(file, 'value'); fs.chmodSync(file, 0o644);
  const fd = openSync(file, 'read');
  const nativeStat = fs.fstatSync, nativeChmod = fs.fchmodSync;
  const calls: string[] = [];
  fs.fstatSync = ((...args: Parameters<typeof fs.fstatSync>) => { calls.push('stat'); return nativeStat(...args); }) as typeof fs.fstatSync;
  fs.fchmodSync = ((...args: Parameters<typeof fs.fchmodSync>) => { calls.push('private'); return nativeChmod(...args); }) as typeof fs.fchmodSync;
  syncBuiltinESMExports();
  try {
    const before = fstatSync(fd);
    assert.deepEqual(calls, ['stat']);
    assert.equal(before.owner, 'current'); assert.equal(before.privateAccess, false);
    assert.equal('uid' in before || 'mode' in before, false);
    restrictPrivateAccess(fd, 'file');
    assert.deepEqual(calls, ['stat', 'private']);
    assert.equal(fstatSync(fd).privateAccess, true);
    assert.deepEqual(calls, ['stat', 'private', 'stat']);
    assert.equal(nativeStat(fd).mode & 0o777, 0o600);
  } finally {
    fs.fstatSync = nativeStat; fs.fchmodSync = nativeChmod; syncBuiltinESMExports();
    closeSync(fd); rmSync(root, { recursive: true, force: true });
  }
});

test('unknown required ownership refuses before private-access mutation', { skip: process.platform !== 'linux' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'ce-platform-owner-'));
  const nativeGetuid = process.getuid, before = fs.statSync(root).mode;
  try {
    Reflect.set(process, 'getuid', undefined);
    assert.throws(() => openPrivateDirectory(root, { tighten: true }), /not verified or owned/);
    assert.equal(fs.statSync(root).mode, before);
    assert.deepEqual(readdirSync(root), []);
  } finally { Reflect.set(process, 'getuid', nativeGetuid); rmSync(root, { recursive: true, force: true }); }
});
