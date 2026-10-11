import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, join } from 'node:path';
import { linuxPlatform } from './platform-linux.ts';
import type { FileTarget } from './platform-contract.ts';
import { layout, removeTemps } from './store.ts';
import { fixture, startCli, stopGroup, tempDir, waitForFile } from './testing.ts';

const MANAGED = '# Context Engine Working Contexts are never committed.\n*\n';
const opening = ['--session', 'S1', '--runner', 'test', '--hard-limit', '10000'];
const event = (text: string) => JSON.stringify({ role: 'tool', text });
// The full legacy protocol was reproduced from reviewed pre-29 source in the offline R7 receipt.
// This portable fixture recreates its exclusive name, private bytes, flush and killed creator.
const LEGACY_WRITER = `
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
const file = join(process.argv[1], '.gitignore.ce-' + process.pid + '-' + randomBytes(4).toString('hex') + '.tmp');
const fd = fs.openSync(file, 'wx', 0o600);
fs.writeFileSync(fd, Buffer.from(process.argv[2], 'base64'));
fs.fsyncSync(fd); fs.closeSync(fd);
fs.writeSync(1, JSON.stringify({ file, pid: process.pid }));
process.kill(process.pid, 'SIGKILL');
`;

function prepared() {
  const f = fixture(), managed = join(f.projectRoot, '.context-engine');
  fs.mkdirSync(managed, { mode: 0o700 });
  fs.writeFileSync(join(managed, '.gitignore'), MANAGED, { mode: 0o600 });
  return { f, managed };
}
function artifact(managed: string, bytes: string | Buffer = MANAGED) {
  const made = spawnSync(process.execPath, ['--input-type=module', '-e', LEGACY_WRITER, managed, Buffer.from(bytes).toString('base64')], { encoding: 'utf8' });
  assert.equal(made.signal, 'SIGKILL', made.stderr);
  const r = JSON.parse(made.stdout) as { file: string; pid: number };
  assert.throws(() => process.kill(r.pid, 0), { code: 'ESRCH' });
  return r;
}

test('[issue30 R7] record, sync and another session remove verified dead legacy ignore temporaries', async () => {
  const { f, managed } = prepared();
  for (const [command, sessionId] of [['record', 'S1'], ['sync', 'S1'], ['record', 'S2']]) {
    const a = artifact(managed);
    const result = await startCli(f, [command!, '--session', sessionId!, '--runner', 'test', '--hard-limit', '10000'], { input: event('LEGACY_REOPEN') }).done;
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.equal(fs.existsSync(a.file), false);
    assert.equal(fs.readFileSync(join(managed, '.gitignore'), 'utf8'), MANAGED);
  }
});

for (const kind of ['live-pid', 'user-bytes', 'malformed', 'oversized', 'hardlink', 'symlink', 'nonprivate']) test(`[issue30] ${kind} is retained`, () => {
  const { managed } = prepared();
  const a = artifact(managed, kind === 'user-bytes' ? 'SYNTHETIC_USER_CONTENT' : kind === 'oversized' ? Buffer.alloc(65537, 'X') : MANAGED);
  let file = a.file, other: string | undefined;
  if (kind === 'live-pid' || kind === 'malformed') {
    file = join(managed, kind === 'live-pid' ? `.gitignore.ce-${process.pid}-12345678.tmp` : '.gitignore.ce-0-12345678.tmp');
    fs.renameSync(a.file, file);
  } else if (kind === 'hardlink') {
    other = join(tempDir('other'), 'copy');
    fs.linkSync(file, other);
  } else if (kind === 'symlink') {
    other = join(tempDir('other'), 'user-file');
    fs.writeFileSync(other, 'SYNTHETIC_USER_CONTENT');
    fs.unlinkSync(file);
    fs.symlinkSync(other, file);
  } else if (kind === 'nonprivate') fs.chmodSync(file, 0o644);
  const before = fs.readFileSync(file);
  assert.deepEqual(removeTemps([], [], [managed]), []);
  assert.deepEqual(fs.readFileSync(file), before);
  if (other) assert.equal(fs.existsSync(other), true);
});

for (const owner of ['other', 'unknown'] as const) test(`[issue30] ${owner} descriptor ownership is retained without adoption`, t => {
  const { managed } = prepared();
  const a = artifact(managed), stat = linuxPlatform.fstatSync;
  let checked = false;
  t.mock.method(linuxPlatform, 'fstatSync', (fd: number) => {
    const st = stat(fd);
    if (fs.readlinkSync(`/proc/self/fd/${fd}`) === a.file) { checked = true; return { ...st, owner }; }
    return st;
  });
  assert.deepEqual(removeTemps([], [], [managed]), []);
  assert.equal(checked, true);
  assert.equal(fs.readFileSync(a.file, 'utf8'), MANAGED);
});

for (const code of ['EPERM', 'EACCES', undefined]) test(`[issue30] uncertain PID probe ${code ?? 'unknown'} retains the file`, t => {
  const { managed } = prepared();
  const a = artifact(managed), kill = process.kill;
  t.mock.method(process, 'kill', (pid: number, signal?: NodeJS.Signals | number) => {
    if (pid === a.pid) throw Object.assign(new Error('synthetic uncertain process probe'), { code });
    return kill(pid, signal);
  });
  assert.deepEqual(removeTemps([], [], [managed]), []);
  assert.equal(fs.readFileSync(a.file, 'utf8'), MANAGED);
});

test('[issue30] a detected name replacement is retained before unlink', t => {
  const { managed } = prepared();
  const a = artifact(managed), stat = linuxPlatform.lstatSync;
  let checked = 0;
  t.mock.method(linuxPlatform, 'lstatSync', (path: FileTarget) => {
    if (String(path).endsWith(`/${basename(a.file)}`) && ++checked === 2) {
      fs.renameSync(a.file, `${a.file}.original`);
      fs.writeFileSync(a.file, 'SYNTHETIC_USER_CONTENT', { mode: 0o600 });
    }
    return stat(path);
  });
  assert.deepEqual(removeTemps([], [], [managed]), []);
  assert.equal(fs.readFileSync(a.file, 'utf8'), 'SYNTHETIC_USER_CONTENT');
  assert.equal(fs.readFileSync(`${a.file}.original`, 'utf8'), MANAGED);
});

test('[issue30] corrupted HEAD refuses before legacy cleanup or evidence writes', async () => {
  const { f, managed } = prepared();
  const first = await startCli(f, ['record', ...opening], { input: event('BASE') }).done;
  assert.equal(first.code, 0, first.stdout + first.stderr);
  const paths = layout(f.projectRoot, 'S1', f.stateDir), a = artifact(managed);
  const head = JSON.parse(fs.readFileSync(paths.head, 'utf8'));
  head.through++;
  fs.writeFileSync(paths.head, JSON.stringify(head));
  const log = fs.readFileSync(paths.events), changedHead = fs.readFileSync(paths.head);
  const refused = await startCli(f, ['sync', ...opening]).done;
  assert.equal(refused.code, 1, refused.stdout + refused.stderr);
  assert.match(JSON.parse(refused.stdout).error, /HEAD|sequence|boundary/);
  assert.equal(fs.readFileSync(a.file, 'utf8'), MANAGED);
  assert.deepEqual(fs.readFileSync(paths.events), log);
  assert.deepEqual(fs.readFileSync(paths.head), changedHead);
});

test('[issue30] two sessions can race cleanup without deleting another name or failing on ENOENT', { timeout: 30_000 }, async () => {
  const { f, managed } = prepared();
  const a = artifact(managed), user = join(managed, 'user-file');
  fs.writeFileSync(user, 'SYNTHETIC_USER_CONTENT');
  const signals = [tempDir('cleanup-one'), tempDir('cleanup-two')];
  const runs = ['S1', 'S2'].map((sessionId, i) => startCli(f, ['record', '--session', sessionId, '--runner', 'test', '--hard-limit', '10000'], {
    input: event(sessionId), fault: { call: 'unlinkSync', path: '/\\.context-engine/\\.gitignore\\.ce-\\d+-[0-9a-f]{8}\\.tmp$', at: 'before', action: 'block', dir: signals[i] },
  }));
  try {
    for (const signal of signals) await waitForFile(join(signal, 'blocked'));
    for (const signal of signals) fs.writeFileSync(join(signal, 'release'), '');
    const results = await Promise.all(runs.map(r => r.done));
    results.forEach(r => assert.equal(r.code, 0, r.stdout + r.stderr));
    assert.equal(fs.existsSync(a.file), false);
    assert.equal(fs.readFileSync(user, 'utf8'), 'SYNTHETIC_USER_CONTENT');
  } finally { for (const run of runs) await stopGroup(run.child); }
});

for (const operation of ['unlink', 'flush']) test(`[issue30] cleanup ${operation} IO failure is explicit`, t => {
  const { managed } = prepared();
  const a = artifact(managed);
  if (operation === 'unlink') {
    const unlink = linuxPlatform.unlinkSync;
    t.mock.method(linuxPlatform, 'unlinkSync', (path: FileTarget) => {
      if (String(path).endsWith(`/${basename(a.file)}`)) throw Object.assign(new Error('synthetic unlink failure'), { code: 'EIO' });
      return unlink(path);
    });
  } else {
    const flush = linuxPlatform.fsyncSync;
    t.mock.method(linuxPlatform, 'fsyncSync', (fd: number) => {
      if (fs.readlinkSync(`/proc/self/fd/${fd}`) === managed) throw Object.assign(new Error('synthetic flush failure'), { code: 'EIO' });
      return flush(fd);
    });
  }
  assert.throws(() => removeTemps([], [], [managed]), { code: 'EIO' });
  assert.equal(fs.existsSync(a.file), operation === 'unlink');
});
