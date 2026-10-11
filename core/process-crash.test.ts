// Real process kills during a commit. The CLI process stops itself with SIGKILL at one filesystem
// call (process-faults.ts), so no finally block runs: its operation lock, append lease and
// descriptors are left exactly as a crash leaves them. Recovery then runs in another process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { openSession } from './index.ts';
import type { FaultPlan } from './process-faults.ts';
import { layout } from './store.ts';
import { eventLog, fixture, ownerProcess, startCli, stopGroup, tempDir, waitForFile } from './testing.ts';

const opening = ['--session', 'S1', '--runner', 'test', '--hard-limit', '10000'];
const event = (text: string) => JSON.stringify({ role: 'tool', text });
const count = (text: string, needle: string) => text.split(needle).length - 1;
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

/** Recovery leaves exactly revisions 1..HEAD, no core temp files, a file equal to HEAD and a parseable log. */
function assertRecovered(f: ReturnType<typeof fixture>) {
  const l = layout(f.projectRoot, 'S1', f.stateDir);
  const head = JSON.parse(readFileSync(l.head, 'utf8'));
  assert.deepEqual(readdirSync(l.revisions).sort(), Array.from({ length: head.rev }, (_, i) => `${i + 1}.md`).sort(), 'revisions/ holds exactly 1..HEAD');
  const snapshot = readFileSync(join(l.revisions, `${head.rev}.md`));
  assert.equal(sha(snapshot.toString('utf8')), head.sha, 'HEAD names its snapshot');
  assert.deepEqual(readFileSync(l.workingContext), snapshot, 'the Working Context equals the HEAD snapshot');
  assert.deepEqual([l.stateDir, l.revisions].flatMap((d) => readdirSync(d).filter((n) => n.endsWith('.tmp'))), [], 'no temp file in private state');
  assert.deepEqual(readdirSync(dirname(l.workingContext)).filter((n) => /\.ce-\d+-[0-9a-f]{8}\.tmp$/.test(n)), [], 'no core temp file beside the Working Context');
  assert.deepEqual(readdirSync(dirname(l.workingContext)).filter((n) => n.includes('.ce-preserved-')), [], 'verified predecessor recovery artifacts are retired');
  for (const lease of [`${l.lock}.op`, `${l.events}.append.lock`]) assert.ok(!existsSync(lease), `${lease} is not stranded`);
  return { head, rows: eventLog(l.events), text: readFileSync(l.workingContext, 'utf8') };
}

const steps: Array<{ step: string; fault: FaultPlan; copies: number; lease: boolean }> = [
  { step: 'half-way through the runner-events append', fault: { call: 'writeSync', path: '/events\\.jsonl$', contains: 'SENTINEL', at: 'half', action: 'kill' }, copies: 0, lease: true },
  { step: 'after the runner-events row is flushed', fault: { call: 'fsyncSync', path: '/events\\.jsonl$', contains: 'SENTINEL', at: 'after', action: 'kill' }, copies: 1, lease: true },
  { step: 'after the snapshot rename', fault: { call: 'renameSync', path: '/revisions/2\\.md$', at: 'after', action: 'kill' }, copies: 1, lease: false },
  { step: 'after the HEAD rename', fault: { call: 'renameSync', path: '/HEAD$', at: 'after', action: 'kill' }, copies: 1, lease: false },
  { step: 'before the Working Context rename', fault: { call: 'renameSync', path: '/context\\.md$', at: 'before', action: 'kill' }, copies: 1, lease: false },
  { step: 'after preserving the Working Context predecessor', fault: { call: 'linkSync', path: '\\.ce-preserved-[a-f0-9]{64}\\.bak$', at: 'after', action: 'kill' }, copies: 1, lease: false },
  { step: 'after the Working Context rename', fault: { call: 'renameSync', path: '/context\\.md$', at: 'after', action: 'kill' }, copies: 1, lease: false },
];

for (const { step, fault, copies, lease } of steps) {
  test(`[REC-010] SIGKILL ${step} recovers to one copy of each event`, { timeout: 30_000 }, async () => {
    const f = fixture();
    const owner = ownerProcess();
    try {
      const own = ['--owner-pid', String(owner.pid)];
      assert.equal((await startCli(f, ['record', ...opening, ...own], { input: event('BASE') }).done).code, 0);
      const killed = await startCli(f, ['record', ...opening, ...own], { input: event('SENTINEL'), fault }).done;
      assert.equal(killed.signal, 'SIGKILL', killed.stderr);
      const l = layout(f.projectRoot, 'S1', f.stateDir);
      assert.ok(existsSync(`${l.lock}.op`), 'the killed call left its operation lock');
      assert.equal(existsSync(`${l.events}.append.lock`), lease, 'the killed call left its append lease only inside an append');
      await stopGroup(owner);

      const reopened = await startCli(f, ['sync', ...opening]).done;
      assert.equal(reopened.code, 0, reopened.stdout + reopened.stderr);
      const { head, rows, text } = assertRecovered(f);
      assert.equal(head.rev, 1 + copies);
      assert.equal(count(text, 'BASE'), 1);
      assert.equal(count(text, 'SENTINEL'), copies);
      const takeovers = rows.filter((r) => r.type === 'lock-takeover');
      assert.equal(takeovers.length, 1);
      assert.equal(takeovers[0]!.from.pid, owner.pid);
      assert.equal(rows.filter((r) => r.type === 'runner-events' && JSON.stringify(r.events).includes('SENTINEL')).length, copies);
    } finally {
      await stopGroup(owner);
    }
  });
}

test('[REC-001] after a SIGKILL before HEAD the on-disk HEAD still names the prior revision', { timeout: 30_000 }, async () => {
  const f = fixture();
  assert.equal((await startCli(f, ['record', ...opening], { input: event('BASE') }).done).code, 0);
  const l = layout(f.projectRoot, 'S1', f.stateDir);
  const edited = `${readFileSync(l.workingContext, 'utf8')}\n[[CTX_TURN 2 role=notes]]\nEDIT_SENTINEL\n`;
  writeFileSync(l.workingContext, edited);
  const killed = await startCli(f, ['sync', ...opening], { fault: { call: 'renameSync', path: '/revisions/2\\.md$', at: 'after', action: 'kill' } }).done;
  assert.equal(killed.signal, 'SIGKILL', killed.stderr);

  const head = JSON.parse(readFileSync(l.head, 'utf8'));
  assert.equal(head.rev, 1);
  assert.equal(head.sha, sha(readFileSync(join(l.revisions, '1.md'), 'utf8')));
  const orphan = readFileSync(join(l.revisions, '2.md'), 'utf8');
  assert.equal(orphan, edited, 'revisions/2.md is the orphan snapshot of the edit');

  const reopened = await startCli(f, ['sync', ...opening]).done;
  assert.equal(reopened.code, 0, reopened.stdout + reopened.stderr);
  assert.equal(JSON.parse(reopened.stdout).revision, 2);
  const recovered = assertRecovered(f);
  assert.equal(recovered.head.kind, 'model-edit');
  assert.equal(recovered.head.sha, sha(orphan), 'the unchanged edit commits with the orphan digest');
  assert.equal(recovered.text, edited);
});

test('[CORE-020] SIGKILL between the runner-events append and HEAD publication retries once', { timeout: 30_000 }, async () => {
  const f = fixture();
  const owner = ownerProcess();
  try {
    const args = ['record', ...opening, '--owner-pid', String(owner.pid), '--operation-id', '00000000-0000-4000-8000-0000000000a1'];
    const killed = await startCli(f, args, {
      input: event('RETRY_SENTINEL'),
      fault: { call: 'fsyncSync', path: '/events\\.jsonl$', contains: 'RETRY_SENTINEL', at: 'after', action: 'kill' },
    }).done;
    assert.equal(killed.signal, 'SIGKILL', killed.stderr);
    const l = layout(f.projectRoot, 'S1', f.stateDir);
    assert.ok(!existsSync(l.head), 'the kill landed before any HEAD');

    const retried = await startCli(f, args, { input: event('RETRY_SENTINEL') }).done;
    assert.equal(retried.code, 0, retried.stdout + retried.stderr);
    const { text, rows } = assertRecovered(f);
    assert.equal(count(text, 'RETRY_SENTINEL'), 1);
    const operations = rows.filter((r) => r.type === 'runner-events' && r.operation?.id === '00000000-0000-4000-8000-0000000000a1');
    assert.equal(operations.length, 1);
  } finally {
    await stopGroup(owner);
  }
});

test('[CORE-015] SIGKILL during frame-key creation leaves no torn key', { timeout: 30_000 }, async () => {
  const f = fixture();
  const sig = tempDir('frame-key-sig');
  const child = startCli(f, ['open', ...opening], { fault: { call: 'linkSync', path: '/frame-key$', at: 'before', action: 'block', dir: sig } });
  try {
    await waitForFile(join(sig, 'blocked'));
    const l = layout(f.projectRoot, 'S1', f.stateDir);
    assert.ok(!existsSync(join(l.stateDir, 'frame-key')));
    assert.equal(readdirSync(l.stateDir).filter((n) => n.startsWith('frame-key.ce-')).length, 1, 'the whole temp key was written');
  } finally {
    await stopGroup(child.child);
  }
  assert.equal((await child.done).signal, 'SIGKILL');

  const r = openSession({ ...f, sessionId: 'S1', runner: 'test', hardLimit: 10_000 });
  assert.equal(r.status, 'open');
  assert.match(r.session.frameKey, /^[0-9a-f]{32}$/);
  assert.equal(readFileSync(join(r.session.stateDir, 'frame-key'), 'utf8'), `${r.session.frameKey}\n`);
  assert.deepEqual(readdirSync(r.session.stateDir).filter((n) => n.startsWith('frame-key.')), [], 'no frame-key temp remains');
  r.session.close();
});

test('[CORE-023] a CLI process killed inside the operation lock and append lease strands neither', { timeout: 30_000 }, async () => {
  const f = fixture();
  const killed = await startCli(f, ['record', ...opening], { input: event('FIRST'), fault: { call: 'writeSync', path: '/events\\.jsonl$', at: 'before', action: 'kill' } }).done;
  assert.equal(killed.signal, 'SIGKILL', killed.stderr);
  const l = layout(f.projectRoot, 'S1', f.stateDir);
  assert.ok(existsSync(`${l.lock}.op`) && existsSync(`${l.events}.append.lock`), 'the kill landed inside both');

  // Exit 0 means both dead holders were taken over, not waited out: a live holder ends in SerializeTimeout.
  const next = await startCli(f, ['record', ...opening], { input: event('SECOND') }).done;
  assert.equal(next.code, 0, next.stdout + next.stderr);
  for (const lease of [`${l.lock}.op`, `${l.events}.append.lock`]) assert.ok(!existsSync(lease), `${lease} is not stranded`);
  const text = readFileSync(l.workingContext, 'utf8');
  assert.equal(count(text, 'SECOND'), 1);
  assert.equal(count(text, 'FIRST'), 0);
  eventLog(l.events);
});

test('[CORE-005] a recovery killed after keeping a stale edit keeps it once on retry', { timeout: 30_000 }, async () => {
  const f = fixture();
  const owner = ownerProcess();
  try {
    const own = [...opening, '--owner-pid', String(owner.pid)];
    assert.equal((await startCli(f, ['record', ...own], { input: event('BASE') }).done).code, 0);
    const halted = await startCli(f, ['record', ...own], { input: event('SENTINEL'), fault: { call: 'renameSync', path: '/HEAD$', at: 'after', action: 'kill' } }).done;
    assert.equal(halted.signal, 'SIGKILL', halted.stderr);
    const l = layout(f.projectRoot, 'S1', f.stateDir);
    writeFileSync(l.workingContext, `${readFileSync(l.workingContext, 'utf8')}\n[[CTX_TURN 2 role=notes]]\nSTALE_EDIT\n`);
    const kept = () => eventLog(l.events).filter((r) => r.type === 'restored' && String(r.rejected).includes('STALE_EDIT')).length;

    const crashed = await startCli(f, ['sync', ...own], { fault: { call: 'renameSync', path: '/context\\.md$', at: 'before', action: 'kill' } }).done;
    assert.equal(crashed.signal, 'SIGKILL', crashed.stderr);
    assert.equal(kept(), 1, 'the first recovery kept the edit before it died');
    const retried = await startCli(f, ['sync', ...own]).done;
    assert.equal(retried.code, 0, retried.stdout + retried.stderr);
    assert.equal(kept(), 1, 'the retried recovery does not keep the same edit twice');
    assert.equal(JSON.parse(retried.stdout).receipt?.kind, 'restored', 'the retry still reports the restore');
    assert.equal(count(assertRecovered(f).text, 'SENTINEL'), 1);
  } finally {
    await stopGroup(owner);
  }
});

test('[CORE-005] a file renamed over the Working Context while a stale edit is logged is kept too', { timeout: 30_000 }, async () => {
  const f = fixture();
  const owner = ownerProcess();
  const sig = tempDir('relook-sig');
  try {
    const own = [...opening, '--owner-pid', String(owner.pid)];
    assert.equal((await startCli(f, ['record', ...own], { input: event('BASE') }).done).code, 0);
    const halted = await startCli(f, ['record', ...own], { input: event('SENTINEL'), fault: { call: 'renameSync', path: '/HEAD$', at: 'after', action: 'kill' } }).done;
    assert.equal(halted.signal, 'SIGKILL', halted.stderr);
    const l = layout(f.projectRoot, 'S1', f.stateDir);
    const base = readFileSync(l.workingContext, 'utf8');
    writeFileSync(l.workingContext, `${base}\n[[CTX_TURN 2 role=notes]]\nFIRST_STALE\n`);

    const recovering = startCli(f, ['sync', ...own], { fault: { call: 'fsyncSync', path: '/events\\.jsonl$', contains: '"type":"restored"', at: 'after', action: 'block', dir: sig } });
    await waitForFile(join(sig, 'blocked'));
    const replacement = join(dirname(l.workingContext), 'editor-save');
    writeFileSync(replacement, `${base}\n[[CTX_TURN 2 role=notes]]\nRENAMED_IN\n`);
    renameSync(replacement, l.workingContext);
    writeFileSync(join(sig, 'release'), '');
    const r = await recovering.done;
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const rejected = eventLog(l.events).filter((row) => row.type === 'restored').map((row) => String(row.rejected));
    assert.equal(rejected.filter((t) => t.includes('FIRST_STALE')).length, 1);
    assert.equal(rejected.filter((t) => t.includes('RENAMED_IN')).length, 1, 'the check after the append saw the renamed file');
    assert.equal(count(assertRecovered(f).text, 'SENTINEL'), 1);
  } finally {
    await stopGroup(owner);
  }
});

test('[CORE-005] a Working Context directory swapped for a link during a kept edit refuses with the link error', { timeout: 30_000 }, async () => {
  const f = fixture();
  const owner = ownerProcess();
  const sig = tempDir('swap-sig');
  try {
    const own = [...opening, '--owner-pid', String(owner.pid)];
    assert.equal((await startCli(f, ['record', ...own], { input: event('BASE') }).done).code, 0);
    const halted = await startCli(f, ['record', ...own], { input: event('SENTINEL'), fault: { call: 'renameSync', path: '/HEAD$', at: 'after', action: 'kill' } }).done;
    assert.equal(halted.signal, 'SIGKILL', halted.stderr);
    const l = layout(f.projectRoot, 'S1', f.stateDir);
    writeFileSync(l.workingContext, `${readFileSync(l.workingContext, 'utf8')}\n[[CTX_TURN 2 role=notes]]\nSTALE_EDIT\n`);

    const recovering = startCli(f, ['sync', ...own], { fault: { call: 'fsyncSync', path: '/events\\.jsonl$', contains: '"type":"restored"', at: 'after', action: 'block', dir: sig } });
    await waitForFile(join(sig, 'blocked'));
    const dir = dirname(l.workingContext);
    renameSync(dir, `${dir}-moved`);
    symlinkSync(`${dir}-moved`, dir);
    writeFileSync(join(sig, 'release'), '');
    const r = await recovering.done;
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.match(JSON.parse(r.stdout).error, /symbolic link/, 'the refusal names the link, not a descriptor error from cleanup');
  } finally {
    await stopGroup(owner);
  }
});

test('[CORE-001] a first open killed between creating and writing the managed .gitignore does not wedge the project', { timeout: 30_000 }, async () => {
  const f = fixture();
  const ignore = join(f.projectRoot, '.context-engine', '.gitignore');
  const killed = await startCli(f, ['record', ...opening], { input: event('FIRST'), fault: { call: 'writeFileSync', path: '/\\.context-engine/\\.gitignore$', at: 'before', action: 'kill' } }).done;
  assert.equal(killed.signal, 'SIGKILL', killed.stderr);
  assert.equal(readFileSync(ignore, 'utf8'), '', 'the kill left an empty managed .gitignore');

  const next = await startCli(f, ['record', ...opening], { input: event('SECOND') }).done;
  assert.equal(next.code, 0, next.stdout + next.stderr);
  assert.equal(readFileSync(ignore, 'utf8').trim().split('\n').at(-1), '*');
  assert.equal(count(readFileSync(layout(f.projectRoot, 'S1', f.stateDir).workingContext, 'utf8'), 'SECOND'), 1);

  // Only an empty, single-name file of this user is repaired. Anything else still refuses unchanged.
  for (const [label, prepare, refusal] of [
    ['foreign rules', (path: string) => writeFileSync(path, 'node_modules\n'), /blanket \* rule/],
    ['a hard link', (path: string) => { const other = join(tempDir('ignore-link'), 'other'); writeFileSync(other, ''); linkSync(other, path); }, /regular, unlinked/],
  ] as const) {
    const g = fixture();
    mkdirSync(join(g.projectRoot, '.context-engine'), { mode: 0o700 });
    const path = join(g.projectRoot, '.context-engine', '.gitignore');
    prepare(path);
    const before = readFileSync(path);
    const refused = await startCli(g, ['record', ...opening], { input: event('REFUSED') }).done;
    assert.equal(refused.code, 1, `${label}: ${refused.stdout}`);
    assert.match(JSON.parse(refused.stdout).error, refusal, label);
    assert.deepEqual(readFileSync(path), before, `${label} is left unchanged`);
  }
});
