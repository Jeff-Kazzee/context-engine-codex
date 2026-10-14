import './testing/private-tmp.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openSession } from '../../core/index.ts';
import { layout } from '../../core/store.ts';
import { pendingRestoreNotices } from '../../core/restore-notices.ts';
import { enabledFixture, runHook, prompt, toolUse, newContext, preCompact } from './testing/hook-process.ts';

for (const [name, fields] of [
  ['prompt', prompt('RESTORE_NOTICE_PROMPT')],
  ['tool', toolUse('Bash', { command: 'synthetic ordinary command' }, 'TOOL_OUTPUT', 'notice-tool')],
  ['reset', newContext],
  ['compact', preCompact],
] as const) {
  for (const closed of [false, true]) test(`issue31: ${name} hook keeps restore pending without host acknowledgment (${closed})`, async () => {
    const f = enabledFixture(), opts = { ...f, sessionId: 'S1', runner: 'codex', hardLimit: 400000 };
    const opened = openSession(opts); assert.equal(opened.status, 'open');
    opened.session.record([{ role: 'user', text: 'ORIGINAL' }]);
    writeFileSync(opened.session.workingContextPath, '');
    const notice = opened.session.sync().restoreNotices![0]!;
    const out = await runHook(f, 'S1', fields, {}, 30000, closed);
    const log = layout(f.projectRoot, 'S1', f.stateDir).events;
    if (!closed) {
      assert.equal(out.status, 0, out.stderr);
      assert.match(out.stdout, /restore request\(s\).*pending/);
      const next = await runHook(f, 'S1', prompt('NEXT_REQUEST'));
      assert.equal(next.status, 0, next.stderr);
      assert.match(next.stdout, /restore request\(s\).*pending/, 'the next hook reoffers a notice without a host acknowledgment');
    }
    assert.equal(pendingRestoreNotices(log).get(notice.id)?.id, notice.id, 'stdout is not evidence that Codex accepted hook output');
    opened.session.close();
  });
}


test('issue31: SIGKILL after stdout cannot confirm a restore notice before hook acceptance', async () => {
  const f = enabledFixture(), opts = { ...f, sessionId: 'S1', runner: 'codex', hardLimit: 400000 };
  const opened = openSession(opts); assert.equal(opened.status, 'open');
  try {
    opened.session.record([{ role: 'user', text: 'ORIGINAL' }]);
    writeFileSync(opened.session.workingContextPath, '');
    const notice = opened.session.sync().restoreNotices![0]!;
    const preload = join(f.projectRoot, 'kill-after-output.mjs');
    writeFileSync(preload, `import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
const hook=process.argv[1]?.endsWith('/codex-hook.ts');let emitted=false;
const write=fs.writeSync;fs.writeSync=function(fd,...args){const n=write.call(this,fd,...args);if(hook&&fd===1&&n>0)emitted=true;return n;};
const rename=fs.renameSync;fs.renameSync=function(from,to){if(hook&&emitted&&String(to).endsWith('/codex-read-notice.json'))process.kill(process.pid,'SIGKILL');return rename.call(this,from,to);};
syncBuiltinESMExports();
`);
    const killed = await runHook(f, 'S1', prompt('KILLED_REQUEST'), { NODE_OPTIONS: '--import=' + preload });
    assert.equal(killed.signal, 'SIGKILL', JSON.stringify(killed));
    assert.equal(killed.timedOut, false, 'the targeted post-output fault fired before the harness deadline');
    assert.match(killed.stdout, /restore request\(s\).*pending/);
    const log = layout(f.projectRoot, 'S1', f.stateDir).events;
    assert.equal(pendingRestoreNotices(log).get(notice.id)?.id, notice.id, 'a failed hook output is not accepted by Codex');
    const next = await runHook(f, 'S1', prompt('AFTER_KILLED_REQUEST'));
    assert.equal(next.status, 0, next.stderr);
    assert.match(next.stdout, /restore request\(s\).*pending/);
    assert.equal(pendingRestoreNotices(log).get(notice.id)?.id, notice.id);
  } finally { opened.session.close(); }
});

test('issue31: an explicit observed-transport confirmation releases the restore reset gate', async () => {
  const f = enabledFixture(), opts = { ...f, sessionId: 'S1', runner: 'codex', hardLimit: 400000 };
  const opened = openSession(opts); assert.equal(opened.status, 'open');
  try {
    opened.session.record([{ role: 'user', text: 'ORIGINAL' }]);
    writeFileSync(opened.session.workingContextPath, '');
    const notice = opened.session.sync().restoreNotices![0]!;
    const first = await runHook(f, 'S1', newContext);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(JSON.parse(first.stdout).hookSpecificOutput.permissionDecision, 'deny');
    const log = layout(f.projectRoot, 'S1', f.stateDir).events;
    assert.equal(pendingRestoreNotices(log).get(notice.id)?.id, notice.id);
    // This fixture is the separate transport observer. A native hook has no such signal.
    opened.session.confirmRestoreNotices([notice.id]);
    assert.equal(pendingRestoreNotices(log).size, 0);
    const next = await runHook(f, 'S1', newContext);
    assert.equal(next.status, 0, next.stderr);
    assert.equal(next.stdout, '', 'the existing reset policy permits a usable context after explicit confirmation');
  } finally { opened.session.close(); }
});
