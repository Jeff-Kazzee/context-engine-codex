import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { ensureDirs, layout } from './store.ts';
import { closeSync, openSync } from './platform.ts';
import { fixture, startCli, stopGroup, tempDir, waitForFile } from './testing.ts';

const RULES = '# my concurrent rules\nnode_modules\n*\n';
const MANAGED = '# Context Engine Working Contexts are never committed.\n*\n';
const IGNORE = '/\\.context-engine/\\.gitignore$';
const opening = ['--session', 'S1', '--runner', 'test', '--hard-limit', '10000'];
const event = (text: string) => JSON.stringify({ role: 'tool', text });

function emptyIgnore() {
  const f = fixture();
  const paths = layout(f.projectRoot, 'S1', f.stateDir);
  const managed = join(f.projectRoot, '.context-engine');
  fs.mkdirSync(managed, { mode: 0o700 });
  const ignore = join(managed, '.gitignore');
  fs.writeFileSync(ignore, '', { mode: 0o600 });
  return { f, paths, managed, ignore };
}

function shown(target: unknown): string {
  try {
    if (typeof target === 'number') return fs.readlinkSync(`/proc/self/fd/${target}`);
    return join(fs.realpathSync(dirname(String(target))), String(target).split('/').at(-1)!);
  } catch { return ''; }
}

for (const mode of ['in-place', 'rename-save', 'in-place-no-newline']) test(`[issue29 R5] concurrent ${mode} rules survive empty ignore repair`, t => {
  const { f, paths, ignore } = emptyIgnore();
  let fired = false;
  const change = () => {
    fired = true;
    if (mode.startsWith('in-place')) fs.writeFileSync(ignore, mode.endsWith('no-newline') ? RULES.trimEnd() : RULES);
    else {
      fs.writeFileSync(`${ignore}.mine`, RULES, { mode: 0o600 });
      fs.renameSync(`${ignore}.mine`, ignore);
    }
  };
  const rename = fs.renameSync, write = fs.writeSync;
  const renameSpy = t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
    if (!fired && shown(to) === ignore) change();
    return rename(from, to);
  });
  const writeSpy = t.mock.method(fs, 'writeSync', (...args: unknown[]) => {
    if (!fired && shown(args[0]) === ignore) change();
    return Reflect.apply(write, fs, args);
  });
  syncBuiltinESMExports();
  let error: unknown;
  try { ensureDirs(paths, f.stateDir); }
  catch (e) { error = e; }
  finally { renameSpy.mock.restore(); writeSpy.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(fired, true, 'the edit landed at the repair publication boundary');
  const after = fs.readFileSync(ignore, 'utf8');
  if (mode.startsWith('in-place')) {
    assert.ok(after.startsWith(mode.endsWith('no-newline') ? RULES.trimEnd() : RULES), 'repair must preserve the concurrent rules before its appended block');
    assert.ok(after.includes(`\n${MANAGED}`), 'a prefix newline separates concurrent content from the managed block');
    assert.equal(error, undefined);
  } else {
    assert.equal(after, RULES, 'repair must never replace the editor\'s saved inode');
    assert.match(String(error), /changed.*repair/);
  }
  assert.equal(fs.existsSync(paths.events), false);
  assert.equal(fs.existsSync(paths.head), false);
});

test('[issue29] append-existing refuses absent names and symlinks without creating or following them', () => {
  const root = tempDir('append-existing'), absent = join(root, 'absent'), target = join(root, 'target');
  assert.throws(() => openSync(absent, 'append-existing'), { code: 'ENOENT' });
  assert.equal(fs.existsSync(absent), false);
  fs.writeFileSync(target, 'untouched');
  fs.symlinkSync(target, absent);
  assert.throws(() => openSync(absent, 'append-existing'), { code: 'ELOOP' });
  assert.equal(fs.readFileSync(target, 'utf8'), 'untouched');
  const fd = openSync(target, 'append-existing');
  closeSync(fd);
});

test('[issue29] a repair completed before the append handle is inspected is not appended again', t => {
  const { f, paths, ignore } = emptyIgnore();
  const open = fs.openSync, write = fs.writeSync;
  let completed = false, appended = false;
  const openSpy = t.mock.method(fs, 'openSync', (...args: unknown[]) => {
    const fd = Reflect.apply(open, fs, args);
    if (typeof args[1] === 'number' && (args[1] & fs.constants.O_APPEND) && shown(fd) === ignore) {
      completed = true;
      fs.writeFileSync(ignore, RULES);
    }
    return fd;
  });
  const writeSpy = t.mock.method(fs, 'writeSync', (...args: unknown[]) => {
    if (shown(args[0]) === ignore && Buffer.isBuffer(args[1]) && args[1].includes(MANAGED)) appended = true;
    return Reflect.apply(write, fs, args);
  });
  syncBuiltinESMExports();
  try { ensureDirs(paths, f.stateDir); }
  finally { openSpy.mock.restore(); writeSpy.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(completed, true);
  assert.equal(appended, false);
  assert.equal(fs.readFileSync(ignore, 'utf8'), RULES);
});

test('[issue29] single-link ownership proof is rechecked immediately before append', t => {
  const { f, paths, ignore } = emptyIgnore();
  const open = fs.openSync, stat = fs.fstatSync;
  let appendFd: number | undefined, checks = 0;
  const openSpy = t.mock.method(fs, 'openSync', (...args: unknown[]) => {
    const fd = Reflect.apply(open, fs, args);
    if (typeof args[1] === 'number' && (args[1] & fs.constants.O_APPEND) && shown(fd) === ignore) appendFd = fd;
    return fd;
  });
  const statSpy = t.mock.method(fs, 'fstatSync', (...args: unknown[]) => {
    if (args[0] === appendFd && ++checks === 2) fs.linkSync(ignore, `${ignore}.other`);
    return Reflect.apply(stat, fs, args);
  });
  syncBuiltinESMExports();
  try { assert.throws(() => ensureDirs(paths, f.stateDir), /changed.*repair/); }
  finally { openSpy.mock.restore(); statSpy.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(checks >= 2, true);
  assert.equal(fs.readFileSync(ignore, 'utf8'), '');
  assert.equal(fs.statSync(ignore).nlink, 2);
  assert.equal(fs.existsSync(paths.head), false);
  assert.equal(fs.existsSync(paths.events), false);
});

test('[issue29] invalid rules written after the append are retained and refuse before publication', t => {
  const { f, paths, ignore } = emptyIgnore();
  const write = fs.writeSync;
  let changed = false;
  const spy = t.mock.method(fs, 'writeSync', (...args: unknown[]) => {
    const result = Reflect.apply(write, fs, args);
    if (!changed && shown(args[0]) === ignore) {
      changed = true;
      fs.writeFileSync(ignore, 'node_modules\n');
    }
    return result;
  });
  syncBuiltinESMExports();
  try { assert.throws(() => ensureDirs(paths, f.stateDir), /blanket \* rule.*fix/i); }
  finally { spy.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(changed, true);
  assert.equal(fs.readFileSync(ignore, 'utf8'), 'node_modules\n');
  assert.equal(fs.existsSync(paths.head), false);
  assert.equal(fs.existsSync(paths.events), false);
});

for (const failure of ['short-write', 'ENOSPC']) test(`[issue29] ${failure} during repair retains bytes and fails explicitly`, t => {
  const { f, paths, ignore } = emptyIgnore();
  const write = fs.writeSync;
  let fired = false;
  const spy = t.mock.method(fs, 'writeSync', (...args: unknown[]) => {
    if (!fired && shown(args[0]) === ignore) {
      fired = true;
      if (failure === 'ENOSPC') throw Object.assign(new Error('synthetic disk full'), { code: 'ENOSPC' });
      const bytes = args[1] as Buffer;
      return write(args[0] as number, bytes, 0, bytes.length >> 1, null);
    }
    return Reflect.apply(write, fs, args);
  });
  syncBuiltinESMExports();
  try { assert.throws(() => ensureDirs(paths, f.stateDir), /repair.*retained.*review/i); }
  finally { spy.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(fired, true);
  const after = fs.readFileSync(ignore);
  assert.equal(after.length, failure === 'ENOSPC' ? 0 : Buffer.byteLength(`\n${MANAGED}`) >> 1);
  assert.equal(fs.existsSync(paths.head), false);
  assert.equal(fs.existsSync(paths.events), false);
  if (failure === 'short-write') {
    assert.throws(() => ensureDirs(paths, f.stateDir), /blanket \* rule.*fix/i);
    assert.deepEqual(fs.readFileSync(ignore), after, 'restart never removes an incomplete append prefix');
  } else {
    ensureDirs(paths, f.stateDir);
    assert.equal(fs.readFileSync(ignore, 'utf8'), `\n${MANAGED}`);
  }
});

test('[issue29] oversized and linked ignore files remain unchanged', () => {
  for (const kind of ['oversized', 'linked']) {
    const { f, paths, ignore } = emptyIgnore();
    if (kind === 'oversized') fs.writeFileSync(ignore, Buffer.alloc(65537, 'X'));
    else fs.linkSync(ignore, `${ignore}.other`);
    const before = fs.readFileSync(ignore);
    assert.throws(() => ensureDirs(paths, f.stateDir), /regular, unlinked/);
    assert.deepEqual(fs.readFileSync(ignore), before);
    assert.equal(fs.existsSync(paths.head), false);
    assert.equal(fs.existsSync(paths.events), false);
  }
});

for (const at of ['before', 'after', 'half'] as const) test(`[issue29] SIGKILL ${at} the repair append has explicit restart behavior`, { timeout: 30_000 }, async () => {
  const { f, paths, ignore } = emptyIgnore();
  const killed = await startCli(f, ['record', ...opening], { input: event('KILLED'), fault: { call: 'writeSync', path: IGNORE, at, action: 'kill' } }).done;
  assert.equal(killed.signal, 'SIGKILL', killed.stdout + killed.stderr);
  const after = fs.readFileSync(ignore);
  assert.equal(fs.existsSync(paths.head), false);
  assert.equal(fs.existsSync(paths.events), false);
  const recovered = await startCli(f, ['record', ...opening], { input: event('RESTART') }).done;
  if (at === 'half') {
    assert.equal(recovered.code, 1, recovered.stdout + recovered.stderr);
    assert.match(JSON.parse(recovered.stdout).error, /blanket \* rule.*fix/i);
    assert.deepEqual(fs.readFileSync(ignore), after);
    assert.equal(fs.existsSync(paths.head), false);
    assert.equal(fs.existsSync(paths.events), false);
  } else {
    assert.equal(recovered.code, 0, recovered.stdout + recovered.stderr);
    assert.equal(fs.readFileSync(ignore, 'utf8'), `\n${MANAGED}`);
    assert.match(fs.readFileSync(paths.workingContext, 'utf8'), /RESTART/);
  }
});

test('[issue29] two simultaneous repairers preserve semantic ignore behavior and both records', { timeout: 30_000 }, async () => {
  const { f, ignore, managed } = emptyIgnore();
  const signals = [tempDir('repair-one'), tempDir('repair-two')];
  const runs = ['S1', 'S2'].map((sessionId, i) => startCli(f, ['record', '--session', sessionId, '--runner', 'test', '--hard-limit', '10000'], {
    input: event(`${sessionId}_EVENT`), fault: { call: 'writeSync', path: IGNORE, at: 'before', action: 'block', dir: signals[i] },
  }));
  try {
    for (const signal of signals) await waitForFile(join(signal, 'blocked'));
    for (const signal of signals) fs.writeFileSync(join(signal, 'release'), '');
    const results = await Promise.all(runs.map(r => r.done));
    results.forEach(r => assert.equal(r.code, 0, r.stdout + r.stderr));
    const text = fs.readFileSync(ignore, 'utf8');
    assert.equal(text.split(MANAGED).length - 1, 2, 'only the two already-racing repairers appended');
    assert.equal(text.trim().split('\n').at(-1), '*');
    assert.deepEqual(fs.readdirSync(managed).filter(n => n.startsWith('.gitignore.')), []);
    for (const sessionId of ['S1', 'S2']) assert.match(fs.readFileSync(layout(f.projectRoot, sessionId, f.stateDir).workingContext, 'utf8'), new RegExp(`${sessionId}_EVENT`));
    const stable = fs.readFileSync(ignore);
    ensureDirs(layout(f.projectRoot, 'S3', f.stateDir), f.stateDir);
    assert.deepEqual(fs.readFileSync(ignore), stable, 'later opens do not keep adding blocks');
  } finally { for (const run of runs) await stopGroup(run.child); }
});
