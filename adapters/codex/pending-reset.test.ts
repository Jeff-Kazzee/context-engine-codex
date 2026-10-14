import './testing/private-tmp.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openSession, readWorkingContext } from '../../core/index.ts';
import { layout } from '../../core/store.ts';
import { pendingRestoreNotices } from '../../core/restore-notices.ts';
import { enabledFixture, runHook, prompt, toolUse, newContext, preCompact, stop } from './testing/hook-process.ts';

function restored() {
  const f = enabledFixture(), opts = { ...f, sessionId: 'S1', runner: 'codex', hardLimit: 400000 };
  const opened = openSession(opts);
  assert.equal(opened.status, 'open');
  const s = opened.session;
  s.record([{ role: 'user', text: 'CURRENT_TASK' }]);
  writeFileSync(s.workingContextPath, '');
  const r = s.sync();
  return { f, s, id: r.restoreNotices![0]!.id, text: r.workingContextText!, log: layout(f.projectRoot, 'S1', f.stateDir).events };
}

test('native reset proceeds after a complete current read without retiring the restore warning', async () => {
  const t = restored();
  try {
    const read = await runHook(t.f, 'S1', toolUse('Bash', { command: `cat ${t.s.workingContextPath}` }, t.text, 'restore-read'));
    assert.equal(read.status, 0, read.stderr);
    const reset = await runHook(t.f, 'S1', newContext);
    assert.equal(reset.status, 0, reset.stderr);
    assert.equal(reset.stdout, '', 'a safely read context can reset even though host acceptance is unknown');
    assert.equal(pendingRestoreNotices(t.log).get(t.id)?.id, t.id);
    const next = await runHook(t.f, 'S1', prompt('AFTER_RESET'));
    assert.match(next.stdout, /restore request\(s\).*pending/);
  } finally { t.s.close(); }
});

test('native compaction of a readable preserved context does not deadlock on warning acceptance', async () => {
  const t = restored();
  try {
    const compact = await runHook(t.f, 'S1', preCompact);
    assert.equal(compact.status, 0, compact.stderr);
    assert.equal(JSON.parse(compact.stdout || '{}').continue, undefined, 'the warning alone must not abort native compaction');
    assert.equal(pendingRestoreNotices(t.log).get(t.id)?.id, t.id);
    const next = await runHook(t.f, 'S1', prompt('AFTER_COMPACT'));
    assert.match(next.stdout, /restore request\(s\).*pending/);
  } finally { t.s.close(); }
});

test('partial read does not satisfy the native reset safety barrier', async () => {
  const t = restored();
  try {
    await runHook(t.f, 'S1', toolUse('Bash', { command: `cat ${t.s.workingContextPath}` }, t.text.slice(0, 5), 'partial-read'));
    const reset = await runHook(t.f, 'S1', newContext);
    assert.equal(JSON.parse(reset.stdout).hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(pendingRestoreNotices(t.log).get(t.id)?.id, t.id);
  } finally { t.s.close(); }
});

test('an identical-byte new restore attempt invalidates an earlier complete read', async () => {
  const t = restored();
  try {
    await runHook(t.f, 'S1', toolUse('Bash', { command: `cat ${t.s.workingContextPath}` }, t.text, 'first-read'));
    writeFileSync(t.s.workingContextPath, '');
    const newer = t.s.sync();
    assert.equal(newer.workingContextText, t.text);
    assert.equal(newer.restoreNoticesTotal, 2);
    const reset = await runHook(t.f, 'S1', newContext);
    assert.equal(JSON.parse(reset.stdout).hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(pendingRestoreNotices(t.log).size, 2);
  } finally { t.s.close(); }
});

test('editing current bytes invalidates an earlier complete restore read', async () => {
  const t = restored();
  try {
    await runHook(t.f, 'S1', toolUse('Bash', { command: `cat ${t.s.workingContextPath}` }, t.text, 'old-read'));
    writeFileSync(t.s.workingContextPath, t.text + '\nNEW_TASK_DETAIL');
    t.s.sync();
    const reset = await runHook(t.f, 'S1', newContext);
    assert.equal(JSON.parse(reset.stdout).hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(pendingRestoreNotices(t.log).get(t.id)?.id, t.id);
  } finally { t.s.close(); }
});

for (const framed of [false, true]) test(`all sequential digest-bound read parts satisfy reset safety (${framed})`, async () => {
  const t = restored();
  try {
    writeFileSync(t.s.workingContextPath, '[[CTX_TURN 1 role=user]]\n' + 'ROW_CONTENT\n'.repeat(4000));
    t.s.sync();
    writeFileSync(t.s.workingContextPath, '');
    t.s.sync();
    const first = readWorkingContext({ ...t.f, sessionId: 'S1', framed });
    assert.ok(first.parts > 1);
    for (let part = 1; part <= first.parts; part++) {
      const response = readWorkingContext({ ...t.f, sessionId: 'S1', part, sha: first.sha, framed });
      const command = `context-engine read --session S1 --part ${part} --sha ${first.sha}${framed ? ' --framed' : ''}`;
      const read = await runHook(t.f, 'S1', toolUse('Bash', { command }, response.text, `part-${part}`));
      assert.equal(read.status, 0, read.stderr);
      if (part < first.parts) {
        const reset = await runHook(t.f, 'S1', newContext);
        assert.equal(JSON.parse(reset.stdout).hookSpecificOutput.permissionDecision, 'deny');
      }
    }
    const reset = await runHook(t.f, 'S1', newContext);
    assert.equal(reset.stdout, '', reset.stderr);
    assert.equal(pendingRestoreNotices(t.log).size, 2);
  } finally { t.s.close(); }
});

test('a committed edit notice pending after Stop does not abort readable native compaction', async () => {
  const f = enabledFixture(), opened = openSession({ ...f, sessionId: 'S1', runner: 'codex', hardLimit: 400000 });
  assert.equal(opened.status, 'open');
  const s = opened.session;
  try {
    s.record([{ role: 'user', text: 'CURRENT_TASK' }]);
    writeFileSync(s.workingContextPath, '[[CTX_TURN 1 role=user]]\nEDITED_CURRENT_TASK');
    const stopped = await runHook(f, 'S1', stop('RECORDED_ANSWER'));
    assert.equal(stopped.status, 0, stopped.stderr);
    const compact = await runHook(f, 'S1', preCompact);
    assert.equal(compact.status, 0, compact.stderr);
    assert.equal(JSON.parse(compact.stdout || '{}').continue, undefined);
    const next = await runHook(f, 'S1', prompt('AFTER_COMPACT'));
    assert.match(next.stdout, /--sha/);
  } finally { s.close(); }
});

test('native compaction still refuses unrecorded completed-event debt', async () => {
  const t = restored();
  try {
    writeFileSync(join(t.s.stateDir, 'codex-record-pending.json'), '{}', { mode: 0o600 });
    const compact = await runHook(t.f, 'S1', preCompact);
    assert.equal(JSON.parse(compact.stdout).continue, false);
    assert.match(compact.stdout, /earlier completed tool or assistant event/);
    assert.equal(pendingRestoreNotices(t.log).get(t.id)?.id, t.id);
  } finally { t.s.close(); }
});
