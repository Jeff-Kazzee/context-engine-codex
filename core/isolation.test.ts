import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, statSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, relative } from 'node:path';
import { openSession, type OpenOptions, type Session } from './index.ts';
import { fixture, tempDir } from './testing.ts';

const base = (f: ReturnType<typeof fixture>, extra: Partial<OpenOptions> = {}): OpenOptions => ({
  ...f,
  sessionId: 'S1',
  runner: 'test',
  hardLimit: 10_000,
  ...extra,
});

function open(opts: OpenOptions): Session {
  const r = openSession(opts);
  assert.equal(r.status, 'open');
  return r.session;
}

const logTypes = (s: Session) =>
  readFileSync(join(s.stateDir, 'events.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as { type: string; from?: { pid: number } });

test('duplicate writer is refused while the holder lives; a dead holder is taken over and logged', async () => {
  const f = fixture();
  const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' });
  try {
    const first = open(base(f, { ownerPid: holder.pid! }));
    first.record([{ role: 'user', text: 'Task.' }]);

    const second = openSession(base(f));
    assert.equal(second.status, 'refused');
    assert.equal(second.status === 'refused' && second.holder.pid, holder.pid);
    assert.equal(second.status === 'refused' && second.holder.hostname, hostname());

    holder.kill('SIGKILL');
    await once(holder, 'exit');

    const takeover = open(base(f));
    assert.equal(takeover.sync().revision, 1, 'continues from the latest committed revision');
    const t = logTypes(takeover).find((e) => e.type === 'lock-takeover');
    assert.equal(t?.from?.pid, holder.pid);
  } finally {
    holder.kill('SIGKILL');
  }
});

test('a lock left by an already-dead process is stale', () => {
  const f = fixture();
  const dead = spawnSync(process.execPath, ['-e', '0']).pid!;
  open(base(f, { ownerPid: dead }));
  open(base(f));
});

test('the same owner may reopen its own session (re-entrant), and close releases the lock', () => {
  const f = fixture();
  const a = open(base(f));
  open(base(f));
  a.close();
  assert.throws(() => a.sync(), /closed/);
  const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' });
  try {
    open(base(f, { ownerPid: holder.pid! })); // free after close
  } finally {
    holder.kill('SIGKILL');
  }
});

test('projects and sessions are isolated: separate files, nothing leaks', () => {
  const f = fixture();
  const otherProject = tempDir('project');
  const a1 = open(base(f));
  a1.record([{ role: 'user', text: 'PROJECT-A-SECRET' }]);
  const b1 = open(base({ ...f, projectRoot: otherProject }));
  const a2 = open(base(f, { sessionId: 'S2' }));

  for (const s of [b1, a2]) {
    assert.deepEqual(s.sync(), { revision: 0, turns: [], chars: 0, workingContextText: '' });
    s.record([{ role: 'user', text: 'own task' }]);
    assert.ok(!readFileSync(s.workingContextPath, 'utf8').includes('PROJECT-A-SECRET'));
  }
  const paths = new Set([a1, b1, a2].flatMap((s) => [s.workingContextPath, s.stateDir]));
  assert.equal(paths.size, 6);
  assert.equal(a1.sync().revision, 1);
});

test('same-named projects in different places get different state directories', () => {
  const stateDir = join(tempDir('state'), 'context-engine');
  const p1 = join(tempDir('a'), 'app');
  const p2 = join(tempDir('b'), 'app');
  for (const p of [p1, p2]) spawnSync('mkdir', ['-p', p]);
  const s1 = open(base({ stateDir, projectRoot: p1 }));
  const s2 = open(base({ stateDir, projectRoot: p2 }));
  assert.notEqual(s1.stateDir, s2.stateDir);
});

test('state lives outside the workspace with mode 0700; the Working Context is inside and gitignored', () => {
  const f = fixture();
  spawnSync('git', ['init', '-q'], { cwd: f.projectRoot });
  const s = open(base(f));
  s.record([{ role: 'user', text: 'Task.' }]);

  assert.ok(relative(f.projectRoot, s.stateDir).startsWith('..'), 'state dir is outside the project');
  for (const d of [f.stateDir, join(s.stateDir, '..'), s.stateDir, join(s.stateDir, 'revisions')]) {
    assert.equal(statSync(d).mode & 0o777, 0o700, d);
  }
  assert.equal(s.workingContextPath, join(f.projectRoot, '.context-engine', 'S1', 'context.md'));
  const ignored = spawnSync('git', ['check-ignore', '-q', s.workingContextPath], { cwd: f.projectRoot });
  assert.equal(ignored.status, 0, 'git ignores the Working Context');
});

test('session ids that could escape their directory are rejected', () => {
  const f = fixture();
  for (const sessionId of ['../x', 'a/b', '', '.hidden']) {
    assert.throws(() => openSession(base(f, { sessionId })), /invalid session id/);
  }
});
