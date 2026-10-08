import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { fixture } from './testing.ts';

const CLI = fileURLToPath(new URL('./cli.ts', import.meta.url));

test('bounded CLI preparation names the accepted model edit and retains its original', () => {
  const f = fixture();
  const env = { ...process.env, CONTEXT_ENGINE_STATE_DIR: f.stateDir };
  const args = ['--session', 'S1', '--project', f.projectRoot, '--runner', 'test', '--hard-limit', '10000', '--owner-pid', String(process.pid)];
  const call = (command: string, extra: string[] = [], input?: string) => {
    const result = spawnSync(process.execPath, [CLI, command, ...args, ...extra], { env, input, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    return JSON.parse(result.stdout);
  };
  const opened = call('open');
  call('record', [], JSON.stringify([{ role: 'user', text: 'ORIGINAL_USER_REQUIREMENT OLD_MEMORY' }]));
  const status = call('status');
  const original = readFileSync(join(status.stateDir, 'revisions', '1.md'), 'utf8');
  const edited = '[[CTX_TURN role=user]]\nORIGINAL_USER_REQUIREMENT NEW_MEMORY\n';
  writeFileSync(opened.workingContext, edited);
  const prepared = call('sync', ['--delivery-max-bytes', '32000']);
  assert.equal(prepared.revisionKind, 'model-edit');
  assert.equal(prepared.delivery.kind, 'ready');
  assert.equal(prepared.delivery.revision, 2);
  assert.equal(prepared.delivery.sha256, createHash('sha256').update(edited).digest('hex'));
  assert.ok(prepared.delivery.text.includes(edited));
  assert.equal(readFileSync(join(status.stateDir, 'revisions', '1.md'), 'utf8'), original);
  assert.match(readFileSync(join(status.stateDir, 'events.jsonl'), 'utf8'), /OLD_MEMORY/);
  const same = call('sync', ['--delivery-max-bytes', '32000']);
  assert.equal(same.receipt, undefined, 'rendering the same revision is not an accepted edit');
  const ordinary = call('record', [], JSON.stringify([{ role: 'tool', text: 'ordinary result' }]));
  assert.equal(ordinary.revisionKind, 'runner-append');
  assert.equal(ordinary.delivery, undefined);
  writeFileSync(opened.workingContext, ' ');
  const restored = call('sync', ['--delivery-max-bytes', '32000']);
  assert.equal(restored.receipt.kind, 'restored');
  assert.equal(restored.revisionKind, 'runner-append');
  assert.ok(restored.workingContextText.includes(edited));
  call('close');
});
