import './testing/private-tmp.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { openSession } from '../../core/index.ts';
import { layout } from '../../core/store.ts';
import { pendingRestoreNotices, restoreNoticeState } from '../../core/restore-notices.ts';
import { enabledFixture, runHook, prompt, toolUse, newContext, preCompact } from './testing/hook-process.ts';

for (const [name, fields] of [
  ['prompt', prompt('RESTORE_NOTICE_PROMPT')],
  ['tool', toolUse('Bash', { command: 'synthetic ordinary command' }, 'TOOL_OUTPUT', 'notice-tool')],
  ['reset', newContext],
  ['compact', preCompact],
] as const) {
  for (const closed of [false, true]) test(`issue31: ${name} hook confirms only completed output (${closed})`, async () => {
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
      assert.equal(pendingRestoreNotices(log).size, 0);
      assert.ok(restoreNoticeState(log).confirmed.has(notice.id));
    } else {
      assert.equal(pendingRestoreNotices(log).get(notice.id)?.id, notice.id, 'a failed pipe cannot confirm the carried notice');
    }
    opened.session.close();
  });
}
