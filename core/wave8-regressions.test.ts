import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { openSession, recall, show } from './index.ts';
import { fixture, tempDir } from './testing.ts';

function opened() {
  const f = fixture(), result = openSession({ ...f, sessionId: 'S1', runner: 'synthetic', hardLimit: 10000 });
  assert.equal(result.status, 'open');
  return { f, s: result.session };
}

for (const kind of ['link', 'invalid-utf8']) test('wave8: no-HEAD rejection cannot unlink through a replaced parent: ' + kind, () => {
  const { f, s } = opened(), wc = s.workingContextPath, parent = dirname(wc), held = `${parent}-held`, outside = tempDir('outside');
  fs.writeFileSync(join(outside, 'context.md'), 'EXTERNAL_SYNTHETIC_KEEP');
  if (kind === 'link') fs.symlinkSync(join(outside, 'context.md'), wc);
  else fs.writeFileSync(wc, Buffer.from([0xff]));
  const write = fs.writeSync;
  let swapped = false;
  fs.writeSync = ((fd: number, ...args: unknown[]) => {
    const result = (write as (...args: unknown[]) => number)(fd, ...args);
    if (!swapped && fs.readlinkSync(`/proc/self/fd/${fd}`) === join(s.stateDir, 'events.jsonl') && String(args[0]).includes('"restored"')) {
      swapped = true; fs.renameSync(parent, held); fs.symlinkSync(outside, parent);
    }
    return result;
  }) as typeof fs.writeSync;
  syncBuiltinESMExports();
  try { try { s.sync(); } catch { /* Refusal is also safe. */ } }
  finally { fs.writeSync = write; syncBuiltinESMExports(); }
  assert.equal(swapped, true, 'swap happened after rejection was classified');
  assert.equal(fs.readFileSync(join(outside, 'context.md'), 'utf8'), 'EXTERNAL_SYNTHETIC_KEEP');
  fs.unlinkSync(parent); fs.renameSync(held, parent); s.close();
});

test('wave8: rejected entry replacement survives cleanup', () => {
  const { s } = opened(), wc = s.workingContextPath;
  fs.writeFileSync(wc, Buffer.from([0xff]));
  const write = fs.writeSync;
  let swapped = false;
  fs.writeSync = ((fd: number, ...args: unknown[]) => {
    const result = (write as (...args: unknown[]) => number)(fd, ...args);
    if (!swapped && fs.readlinkSync(`/proc/self/fd/${fd}`) === join(s.stateDir, 'events.jsonl') && String(args[0]).includes('"restored"')) {
      swapped = true; fs.renameSync(wc, `${wc}.held`); fs.writeFileSync(wc, 'NEW_SYNTHETIC_EDIT');
    }
    return result;
  }) as typeof fs.writeSync;
  syncBuiltinESMExports();
  try { assert.throws(() => s.sync(), /preserved/); }
  finally { fs.writeSync = write; syncBuiltinESMExports(); }
  assert.equal(swapped, true);
  assert.equal(fs.readFileSync(wc, 'utf8'), 'NEW_SYNTHETIC_EDIT'); s.close();
});

test('wave8: rejection has no final unlink window and preserves the original entry', () => {
  const { s } = opened(), wc = s.workingContextPath;
  fs.writeFileSync(wc, Buffer.from([0xff]));
  const unlink = fs.unlinkSync;
  let rejectedUnlinks = 0;
  fs.unlinkSync = ((path: fs.PathLike) => {
    if (String(path).endsWith('/context.md')) {
      rejectedUnlinks++;
      fs.renameSync(wc, `${wc}.held`); fs.writeFileSync(wc, 'CONCURRENT_SYNTHETIC_KEEP');
    }
    return unlink(path);
  }) as typeof fs.unlinkSync;
  syncBuiltinESMExports();
  try { assert.throws(() => s.sync(), /preserved/); }
  finally { fs.unlinkSync = unlink; syncBuiltinESMExports(); }
  assert.equal(rejectedUnlinks, 0);
  assert.deepEqual(fs.readFileSync(wc), Buffer.from([0xff])); s.close();
});

const synthetic = 'SYNTHETIC_CREDENTIAL_VALUE_FOR_TEST_ONLY';
for (const event of [
  { role: 'tool', text: `ANTHROPIC_API_KEY=${synthetic}\nordinary output` },
  { role: 'tool', text: `request failed: Authorization: Bearer ${synthetic}` },
  { role: 'user', text: 'ordinary result', content: [{ type: 'tool_result', content: { access_token: synthetic } }] },
  { role: 'tool', text: 'ordinary result', metadata: { password: 123456789 } },
  { role: 'assistant', text: 'ordinary result', content: [{ type: 'tool_use', input: { command: `export OPENAI_API_KEY='${synthetic}'` } }] },
]) test('wave8: recognized credential event omitted before log, revision and recall: ' + event.role + '/' + ('content' in event ? 'blocks' : 'text'), () => {
  const { f, s } = opened();
  s.record([event]);
  const log = fs.readFileSync(join(s.stateDir, 'events.jsonl'), 'utf8');
  assert.equal(log.includes(synthetic), false);
  assert.equal(fs.readFileSync(s.workingContextPath, 'utf8').includes(synthetic), false);
  assert.equal(recall({ ...f, sessionId: 'S1', query: synthetic }).total, 0);
  assert.equal(JSON.stringify(show({ ...f, sessionId: 'S1', id: 'e1' })).includes(synthetic), false);
  assert.match(log, /omitted-credential/);
  if ('metadata' in event) assert.equal(log.includes('123456789'), false); s.close();
});

test('wave8: safe runner event extras remain intact and mixed batches retain ordinary evidence', () => {
  const { s } = opened(), ordinary = { role: 'tool', text: 'Unit tests passed', content: [{ type: 'tool_result', content: '3 passed' }], usage: { tokens: 3 } };
  s.record([ordinary, { role: 'tool', text: `Authorization: Basic ${synthetic}` }]);
  const rows = fs.readFileSync(join(s.stateDir, 'events.jsonl'), 'utf8').trim().split('\n').map(x => JSON.parse(x));
  const events = rows.find(x => x.type === 'runner-events').events;
  assert.deepEqual(events[0].event, ordinary);
  assert.equal(JSON.stringify(events[1]).includes(synthetic), false); s.close();
});

test('wave8: inspection exhaustion omits all uninspected event payload', () => {
  const { s } = opened(), text = 'x'.repeat(1024 * 1024 + 1) + synthetic;
  s.record([{ role: 'tool', text }]);
  const log = fs.readFileSync(join(s.stateDir, 'events.jsonl'), 'utf8');
  assert.equal(log.includes(synthetic), false);
  assert.match(log, /omitted-inspection-limit/); s.close();
});

test('wave8: deep metadata and accessors are omitted without invoking getters', () => {
  const { s } = opened();
  let deep: unknown = 'safe';
  for (let i = 0; i < 34; i++) deep = { nested: deep };
  const accessor = { role: 'tool', text: 'ordinary output' };
  let reads = 0;
  Object.defineProperty(accessor, 'metadata', { enumerable: true, get() { reads++; return synthetic; } });
  s.record([{ role: 'tool', text: 'ordinary output', deep }, accessor]);
  const log = fs.readFileSync(join(s.stateDir, 'events.jsonl'), 'utf8');
  assert.equal(reads, 0); assert.equal(log.includes(synthetic), false);
  assert.equal(log.match(/omitted-inspection-limit/g)?.length, 2); s.close();
});

test('wave8: native compaction applies the same retention policy', () => {
  const { s } = opened();
  s.record([{ role: 'user', text: 'ordinary task' }]);
  s.nativeCompaction([{ role: 'assistant', text: `Cookie: session=${synthetic}` }]);
  const log = fs.readFileSync(join(s.stateDir, 'events.jsonl'), 'utf8');
  assert.equal(log.includes(synthetic), false);
  assert.equal(fs.readFileSync(s.workingContextPath, 'utf8').includes(synthetic), false);
  assert.match(log, /omitted-credential/); s.close();
});

for (const method of ['record', 'nativeCompaction'] as const) for (const field of ['role', 'text']) test(`wave8: ${method} refuses required ${field} accessors without invoking them`, () => {
  const { s } = opened(), event = { role: 'tool', text: 'ordinary result' };
  const log = join(s.stateDir, 'events.jsonl'), before = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : null;
  let reads = 0;
  Object.defineProperty(event, field, { enumerable: true, get() { reads++; throw new Error('synthetic getter must remain uncalled'); } });
  assert.throws(() => s[method]([event]), /takes an array/);
  assert.equal(reads, 0); assert.equal(fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : null, before); s.close();
});

test('wave8: non-enumerable required fields refuse before any event logging', () => {
  const { s } = opened(), event = {};
  Object.defineProperties(event, { role: { value: 'user' }, text: { value: 'ordinary task' } });
  const log = join(s.stateDir, 'events.jsonl'), before = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : null;
  assert.throws(() => s.record([event as { role: string; text: string }]), /takes an array/);
  assert.equal(fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : null, before); s.close();
});
