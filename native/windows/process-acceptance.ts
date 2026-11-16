import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { openSession, inspectSession, recall } from '../../core/index.ts';
import { readLog } from '../../core/store.ts';
assert.equal(process.platform, 'win32');
const fixture = resolve(process.argv[2]!);
assert.match(fixture, /\\windows-native-20261102\\fixtures$/);
const root = join(fixture, `process-${process.pid}-${Date.now()}`);
mkdirSync(root);
const childFile = fileURLToPath(new URL('./owner-child.ts', import.meta.url));
const env = { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' };
const options = (name: string) => {
  const projectRoot = join(root, name); mkdirSync(projectRoot);
  return { projectRoot, stateDir: join(root, name + '-state'), sessionId: 'WChild', runner: 'parent-acceptance', hardLimit: 100000 };
};
await test('an abrupt kill after durable log append recovers the batch exactly once', () => {
  const ref = options('abrupt');
  const child = spawnSync(process.execPath, [childFile, 'after-log', ref.projectRoot, ref.stateDir, ref.sessionId], { encoding: 'utf8', timeout: 15000, maxBuffer: 65536, windowsHide: true, env });
  assert.equal(child.error, undefined); assert.equal(child.stderr, ''); assert.notEqual(child.status, 0);
  const checkpoint = JSON.parse(child.stdout.trim()); assert.equal(checkpoint.ready, 'after-log');
  const before = inspectSession(ref); assert.equal(before.revision, checkpoint.revision);
  assert.ok(!readFileSync(before.workingContext, 'utf8').includes('Durable after-log sentinel.'));
  const operationId = '42cf10c5-3af3-456b-a7ed-97725f24abae';
  const rows = [...readLog(join(before.stateDir, 'events.jsonl'))];
  assert.equal(rows.filter(row => (row.operation as { id?: string } | undefined)?.id === operationId).length, 1);
  const opened = openSession(ref); assert.equal(opened.status, 'open');
  if (opened.status !== 'open') throw new Error('dead child takeover refused');
  try {
    const recovered = opened.session.sync();
    assert.equal(recovered.workingContextText.split('Durable after-log sentinel.').length - 1, 1);
    const retried = opened.session.record([{ role: 'user', text: 'Durable after-log sentinel.' }], { operationId });
    assert.equal(retried.revision, recovered.revision);
    const after = [...readLog(join(before.stateDir, 'events.jsonl'))];
    assert.equal(after.filter(row => (row.operation as { id?: string } | undefined)?.id === operationId).length, 1);
    assert.equal(recall({ ...ref, query: 'Durable after-log sentinel' }).hits.length, 1);
  } finally { opened.session.close(); }
});
function ready(child: ChildProcess): Promise<{ pid: number; startMarker: string }> {
  return new Promise((resolveReady, reject) => {
    let text = '';
    const timer = setTimeout(() => reject(new Error('owned child did not become ready')), 15000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('owned child exited before readiness')); });
    child.stdout!.on('data', data => {
      text += String(data);
      if (text.length > 65536) { clearTimeout(timer); reject(new Error('owned child output exceeded bound')); }
      else if (text.includes('\n')) {
        clearTimeout(timer);
        try { const row = JSON.parse(text.trim()); assert.equal(row.ready, 'holding'); resolveReady(row); }
        catch (error) { reject(error); }
      }
    });
  });
}
function stopOwnedChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => reject(new Error(`owned child ${child.pid} termination outcome uncertain`)), 10000);
    child.once('exit', () => { clearTimeout(timer); resolveExit(); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    if (!child.kill('SIGKILL')) { clearTimeout(timer); reject(new Error('owned child termination request failed')); }
  });
}
await test('a live native owner refuses contenders and confirmed exit permits takeover', async () => {
  const ref = options('held');
  const child = spawn(process.execPath, [childFile, 'hold', ref.projectRoot, ref.stateDir, ref.sessionId], { windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', data => { stderr += String(data); });
  let marker: string | undefined;
  try {
    const active = await ready(child); assert.equal(active.pid, child.pid); marker = active.startMarker;
    assert.match(marker, /^win32:[1-9][0-9]+$/);
    const refused = openSession(ref);
    if (refused.status !== 'refused') { refused.session.close(); throw new Error('second owner unexpectedly opened'); }
    assert.equal(refused.holder.pid, child.pid); assert.equal(refused.holder.startMarker, marker);
  } finally { await stopOwnedChild(child); }
  assert.equal(stderr, '');
  const taken = openSession(ref); assert.equal(taken.status, 'open');
  if (taken.status !== 'open') throw new Error('confirmed dead-owner takeover refused');
  try { assert.equal(taken.session.sync().workingContextText, ''); }
  finally { taken.session.close(); }
  assert.equal(inspectSession(ref).lock, null);
});
console.log(JSON.stringify({ fixture: root, attemptedProcessCrash: true, powerLossTest: false, liveHookRecoveryClaim: false, fixturesRetained: true }));
