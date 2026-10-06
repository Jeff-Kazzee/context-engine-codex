import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RECALL_MAX_BYTES, SHOW_MAX_BYTES } from './index.ts';
import { fixture, tempDir } from './testing.ts';

const CLI = fileURLToPath(new URL('./cli.ts', import.meta.url));

function cli(f: ReturnType<typeof fixture>, args: string[], input?: string, env: Record<string, string> = {}, cwd = f.projectRoot) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    input,
    encoding: 'utf8',
    env: {
      ...process.env,
      CONTEXT_ENGINE_STATE_DIR: f.stateDir,
      XDG_STATE_HOME: '/nonexistent-should-not-be-used',
      CONTEXT_ENGINE_EXPERIMENTS: '',
      CONTEXT_ENGINE_TEST_PROJECT: '',
      ...env,
    },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json: () => JSON.parse(r.stdout) as Record<string, any> };
}

const session = ['--session', 'S1'];
const opening = [...session, '--runner', 'test', '--hard-limit', '5000'];

test('--help documents the concise command set', () => {
  const r = cli(fixture(), ['--help']);
  assert.equal(r.status, 0);
  for (const cmd of ['open', 'sync', 'record', 'native-compaction', 'close', 'status', 'recall', 'show', 'read']) assert.match(r.stdout, new RegExp(`^  ${cmd}\\b`, 'm'));
  assert.match(r.stdout, /--budget/);
  assert.match(r.stdout, /--hard-limit/);
  assert.match(r.stdout, /CONTEXT_ENGINE_STATE_DIR/);
});

test('open, record, model edit, sync, status, close: every command prints JSON', () => {
  const f = fixture();
  const o = cli(f, ['open', ...opening]);
  assert.equal(o.status, 0, o.stderr);
  const opened = o.json();
  assert.equal(opened.ok, true);
  assert.equal(opened.revision, 0);
  assert.equal(opened.workingContext, `${f.projectRoot}/.context-engine/S1/context.md`);

  const r = cli(f, ['record', ...session], JSON.stringify([{ role: 'user', text: 'Task: fix it.' }, { role: 'tool', text: 'BIG OUTPUT' }]));
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.json().turns, [{ role: 'user', text: 'Task: fix it.\n\nBIG OUTPUT' }]);
  assert.equal(r.json().revision, 1);

  const path = opened.workingContext as string;
  writeFileSync(path, readFileSync(path, 'utf8').replace('BIG OUTPUT', 'note'));
  const s = cli(f, ['sync', ...session]).json();
  assert.equal(s.revision, 2);
  assert.equal(s.receipt.kind, 'committed');
  assert.match(s.receipt.text, /revision 2/);

  const st = cli(f, ['status', ...session]).json();
  assert.equal(st.ok, true);
  assert.equal(st.revision, 2);
  assert.equal(st.lock.pid, process.pid, 'the lock owner defaults to the calling process');
  assert.equal(st.lock.live, true);

  assert.deepEqual(cli(f, ['close', ...session]).json(), { ok: true, closed: true });
  assert.equal(cli(f, ['status', ...session]).json().lock, null);
});

test('a second live owner is refused with JSON and exit code 2', async () => {
  const f = fixture();
  const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' });
  try {
    assert.equal(cli(f, ['open', ...opening, '--owner-pid', String(holder.pid)]).status, 0);
    const refused = cli(f, ['sync', ...session]);
    assert.equal(refused.status, 2);
    assert.equal(refused.json().ok, false);
    assert.equal(refused.json().error, 'refused');
    assert.equal(refused.json().holder.pid, holder.pid);
    holder.kill('SIGKILL');
    await once(holder, 'exit');
    assert.equal(cli(f, ['open', ...opening]).status, 0, 'dead holder is taken over');
  } finally {
    holder.kill('SIGKILL');
  }
});

test('sync and record before open fail with a JSON error unless runner and hard limit are given', () => {
  const f = fixture();
  const r = cli(f, ['sync', ...session]);
  assert.equal(r.status, 1);
  assert.equal(r.json().ok, false);
  assert.match(r.json().error, /open/);
  assert.equal(cli(f, ['sync', ...opening]).status, 0);
});

test('bad input yields a JSON error and exit code 1', () => {
  const f = fixture();
  cli(f, ['open', ...opening]);
  const r = cli(f, ['record', ...session], 'not json');
  assert.equal(r.status, 1);
  assert.equal(r.json().ok, false);
  assert.equal(cli(f, ['frobnicate']).status, 1);
});

test('recall and show through the CLI: bounded JSON, no lock needed, usable while another process holds the session', () => {
  const f = fixture();
  const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' });
  try {
    const big = `${'z'.repeat(10_000)} parseDate Invalid ${'z'.repeat(10_000)}`;
    const events = [{ role: 'user', text: 'Task: fix parseDate.' }, ...Array.from({ length: 150 }, () => ({ role: 'tool', text: 'parseDate: Invalid Date' }))];
    events[1] = { role: 'tool', text: big };
    assert.equal(cli(f, ['record', ...opening, '--owner-pid', String(holder.pid)], JSON.stringify(events)).status, 0);

    const r = cli(f, ['recall', ...session, 'invalid', 'parsedate']);
    assert.equal(r.status, 0, r.stdout);
    assert.ok(Buffer.byteLength(r.stdout) <= RECALL_MAX_BYTES, `${Buffer.byteLength(r.stdout)} bytes`);
    const j = r.json();
    assert.equal(j.ok, true);
    assert.equal(j.query, 'invalid parsedate');
    assert.equal(j.total, 150);
    assert.equal(j.truncated, true);
    assert.equal(j.hits[0].id, 'e151');

    const s = cli(f, ['show', ...session, 'e1']);
    assert.equal(s.status, 0, s.stdout);
    assert.deepEqual(s.json(), { ok: true, id: 'e1', role: 'user', text: 'Task: fix parseDate.', chars: 20, truncated: false });
    const big1 = cli(f, ['show', ...session, 'e2']);
    assert.ok(Buffer.byteLength(big1.stdout) <= SHOW_MAX_BYTES);
    assert.equal(big1.json().truncated, true);

    assert.equal(cli(f, ['status', ...session]).json().lock.pid, holder.pid, 'recall and show leave the lock alone');
  } finally {
    holder.kill('SIGKILL');
  }
});

test('recall and show errors are JSON with exit code 1', () => {
  const f = fixture();
  for (const args of [
    ['recall', ...session, 'anything'],
    ['show', ...session, 'e1'],
  ]) {
    const r = cli(f, args);
    assert.equal(r.status, 1);
    assert.match(r.json().error, /no session S1 in this project/);
  }
  cli(f, ['record', ...opening], JSON.stringify({ role: 'user', text: 'Task.' }));
  assert.match(cli(f, ['recall', ...session]).json().error, /query/);
  assert.match(cli(f, ['show', ...session, 'e9']).json().error, /no event/);
  assert.equal(cli(f, ['show', ...session, 'e1', 'e2']).status, 1);
});

test('recall and show read only sessions of the project the caller is in: no --project, other projects and unknown sessions refused', () => {
  const a = fixture();
  const b = { ...a, projectRoot: tempDir('project') };
  cli(a, ['record', ...opening], JSON.stringify({ role: 'tool', text: 'SECRET-A' }));
  cli(b, ['record', '--session', 'S2', '--runner', 'test', '--hard-limit', '5000'], JSON.stringify({ role: 'tool', text: 'SECRET-B' }));

  // From a subdirectory of project A, A's session is found by walking up.
  mkdirSync(join(a.projectRoot, 'src', 'deep'), { recursive: true });
  const sub = cli(a, ['recall', ...session, 'SECRET'], undefined, {}, join(a.projectRoot, 'src', 'deep'));
  assert.deepEqual(sub.json().hits.map((h: { snippet: string }) => h.snippet), ['SECRET-A']);

  // Cross-project: B's session S2 does not exist in A, so reading it from A is refused.
  for (const args of [
    ['recall', '--session', 'S2', 'SECRET'],
    ['show', '--session', 'S2', 'e1'],
  ]) {
    const r = cli(a, args);
    assert.equal(r.status, 1);
    assert.match(r.json().error, /no session S2 in this project/);
    assert.doesNotMatch(r.stdout, /SECRET-B/);
  }
  // Cross-session: a session id this project never had is refused too.
  assert.match(cli(a, ['recall', '--session', 'S9', 'SECRET']).json().error, /no session S9 in this project/);
  // There is no --project for recall/show: the project is the caller's.
  for (const cmd of [['recall', 'SECRET'], ['show', 'e1']]) {
    const r = cli(a, [cmd[0]!, '--session', 'S2', '--project', b.projectRoot, cmd[1]!]);
    assert.equal(r.status, 1);
    assert.match(r.json().error, /--project/);
  }
  // Tests (only) may point recall at a project explicitly.
  const forced = cli(a, ['recall', '--session', 'S2', 'SECRET'], undefined, { CONTEXT_ENGINE_TEST_PROJECT: b.projectRoot });
  assert.deepEqual(forced.json().hits.map((h: { snippet: string }) => h.snippet), ['SECRET-B']);
});

test('safe failure through the CLI: an emptied file is restored and the receipt says why', () => {
  const f = fixture();
  cli(f, ['record', ...opening], JSON.stringify({ role: 'user', text: 'Task.' }));
  const path = cli(f, ['status', ...session]).json().workingContext as string;
  writeFileSync(path, '');
  const s = cli(f, ['sync', ...session]).json();
  assert.equal(s.receipt.kind, 'restored');
  assert.equal(s.receipt.reason, 'empty');
  assert.match(readFileSync(path, 'utf8'), /Task\./);
});

test('cite prints one marker line; sync with CONTEXT_ENGINE_EXPERIMENTS=stale-refs lists it once stale', () => {
  const f = fixture();
  writeFileSync(`${f.projectRoot}/a.ts`, 'one\ntwo\nthree\n');
  const c = cli(f, ['cite', 'a.ts#L2-3']);
  assert.equal(c.status, 0, c.stdout);
  assert.match(c.stdout, /^⟦src:a\.ts#L2-3@[0-9a-f]{8}⟧\n$/);
  const marker = c.stdout.trim();

  const bad = cli(f, ['cite', 'a.ts#L3-9']);
  assert.equal(bad.status, 1);
  assert.equal(bad.json().ok, false);

  const env = { CONTEXT_ENGINE_EXPERIMENTS: 'stale-refs' };
  const path = cli(f, ['open', ...opening], undefined, env).json().workingContext as string;
  writeFileSync(path, `[[CTX_TURN 1 role=user]]\n${marker}\n`);
  assert.equal(cli(f, ['sync', ...session], undefined, env).json().receipt, undefined);
  writeFileSync(`${f.projectRoot}/a.ts`, 'one\nTWO\nthree\n');
  const s = cli(f, ['sync', ...session], undefined, env).json();
  assert.equal(s.receipt.kind, 'stale');
  assert.deepEqual(s.receipt.stale, { count: 1, refs: [{ marker, reason: 'changed' }] });
  assert.equal(cli(f, ['sync', ...session]).json().receipt, undefined, 'flag off: nothing');
});

test('--if-enabled: in a project nobody enabled, open/sync/record do nothing and say why', () => {
  const f = fixture();
  for (const cmd of ['open', 'sync', 'record']) {
    const r = cli(f, [cmd, ...opening, '--if-enabled'], cmd === 'record' ? '[{"role":"user","text":"hi"}]' : undefined);
    assert.equal(r.status, 0, r.stdout);
    const out = r.json();
    assert.equal(out.ok, true);
    assert.equal(out.active, false);
    assert.match(out.reason, /context-engine enable/);
  }
  assert.equal(existsSync(join(f.projectRoot, '.context-engine')), false, 'no Working Context');
  assert.equal(existsSync(f.stateDir), false, 'no state written');
});

test('enable makes --if-enabled calls go through; disable and the kill switch stop them again', () => {
  const f = fixture();
  const enabled = cli(f, ['enable']);
  assert.equal(enabled.status, 0, enabled.stdout + enabled.stderr);
  const opened = cli(f, ['open', ...opening, '--if-enabled']).json();
  assert.equal(opened.ok, true);
  assert.equal(opened.active, undefined);
  assert.equal(opened.revision, 0);

  const killed = cli(f, ['sync', ...opening, '--if-enabled'], undefined, { CONTEXT_ENGINE: 'off' }).json();
  assert.equal(killed.active, false);
  assert.match(killed.reason, /CONTEXT_ENGINE=off/);

  assert.equal(cli(f, ['disable']).status, 0);
  assert.equal(cli(f, ['sync', ...opening, '--if-enabled']).json().active, false);
});

test('concurrent CLI calls that present the same owner are serialized: every record lands exactly once', async () => {
  // A runner may run several hooks of one session at once (Codex: parallel tool calls), all
  // presenting the runner's pid as owner, so the session lock admits them all.
  const f = fixture();
  const owner = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' });
  try {
    const args = ['record', ...opening, '--owner-pid', String(owner.pid)];
    assert.equal(cli(f, args, JSON.stringify({ role: 'user', text: 'Task.' })).status, 0);
    const runs = Array.from({ length: 8 }, (_, i) => {
      const child = spawn(process.execPath, [CLI, ...args], {
        cwd: f.projectRoot,
        env: { ...process.env, CONTEXT_ENGINE_STATE_DIR: f.stateDir, XDG_STATE_HOME: '/nonexistent-should-not-be-used', CONTEXT_ENGINE_EXPERIMENTS: '' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.stdin.end(JSON.stringify({ role: 'tool', text: `check-${i}` }));
      return once(child, 'exit').then(([code]) => assert.equal(code, 0, out));
    });
    await Promise.all(runs);
    const s = cli(f, ['status', ...session]).json();
    const text = readFileSync(s.workingContext, 'utf8');
    for (let i = 0; i < 8; i++) assert.equal(text.split(`check-${i}\n`).length - 1, 1, `check-${i} recorded once`);
    assert.equal(s.revision, 9);
  } finally {
    owner.kill('SIGKILL');
  }
});

test('--budget: results carry the budget report; native-compaction makes the runner result the next revision, and status says so', () => {
  const f = fixture();
  const budget = ['--budget', '100'];
  assert.equal(cli(f, ['open', ...opening, ...budget]).status, 0);
  const r = cli(f, ['record', ...session, ...budget], JSON.stringify([{ role: 'tool', text: 'x'.repeat(800) }])).json();
  assert.equal(r.budget.budgetTokens, 100);
  assert.equal(r.budget.overBudget, true);
  assert.equal(cli(f, ['sync', ...session]).json().budget, undefined, 'no --budget, no report');
  const n = cli(f, ['native-compaction', ...session, ...budget], JSON.stringify([{ role: 'user', text: 'SUMMARY' }])).json();
  assert.equal(n.ok, true);
  assert.deepEqual(n.turns, [{ role: 'user', text: 'SUMMARY' }]);
  assert.equal(n.budget.overBudget, false);
  assert.equal(cli(f, ['status', ...session]).json().revisionKind, 'native-compaction');
  assert.equal(cli(f, ['sync', ...session, '--budget', '0']).status, 1);
});
