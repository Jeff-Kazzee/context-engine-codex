import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture } from '../../core/testing.ts';
import { setParticipation } from '../../core/index.ts';
import { layout } from '../../core/store.ts';

const hook = fileURLToPath(new URL('./plugin/hooks/codex-hook.ts', import.meta.url));
const cli = fileURLToPath(new URL('../../core/cli.ts', import.meta.url));
const sid = 'W52-COMPLETED';
function setup() {
  const f = fixture();
  setParticipation({ ...f, state: 'on' });
  const state = layout(f.projectRoot, sid, f.stateDir).stateDir;
  const call = (event: Record<string, unknown>, preload?: string, hookPath = hook) => spawnSync(process.execPath, [hookPath], { cwd: f.projectRoot, input: JSON.stringify({ cwd: f.projectRoot, session_id: sid, ...event }), encoding: 'utf8', timeout: 30000, env: { ...process.env, CONTEXT_ENGINE_STATE_DIR: f.stateDir, CONTEXT_ENGINE_CLI: cli, CONTEXT_ENGINE: '', ...(preload ? { NODE_OPTIONS: '--import=' + preload } : {}) } });
  assert.equal(call({ hook_event_name: 'UserPromptSubmit', prompt: 'ORIGINAL_REQUIREMENT' }).status, 0);
  const preload = join(f.projectRoot, 'lost-child-reply.mjs');
  fs.writeFileSync(preload, `import cp from 'node:child_process';import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const native=cp.spawnSync;cp.spawnSync=function(cmd,args,...rest){const result=native(cmd,args,...rest);if(args.includes('record')&&result.status===0){fs.writeFileSync(${JSON.stringify(join(f.projectRoot, 'fault-hit'))},'committed');return {...result,status:1,stdout:'',stderr:'fixture lost child reply'};}return result;};syncBuiltinESMExports();`);
  const rows = () => fs.readFileSync(join(state, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const count = () => rows().filter(row => row.type === 'runner-events' && JSON.stringify(row).includes('COMPLETED_REQUIREMENT')).length;
  const intents = () => fs.readdirSync(state).filter(name => name.startsWith('codex-record-pending-'));
  return { ...f, state, call, preload, count, intents };
}

function completion(kind: 'PostToolUse' | 'Stop', id?: string): Record<string, unknown> {
  return kind === 'PostToolUse'
    ? { hook_event_name: kind, tool_name: 'Read', tool_input: { file_path: 'ordinary.txt' }, tool_response: 'COMPLETED_REQUIREMENT', ...(id ? { tool_use_id: id, turn_id: 'turn-one' } : {}) }
    : { hook_event_name: kind, last_assistant_message: 'COMPLETED_REQUIREMENT', ...(id ? { turn_id: id } : {}) };
}

for (const kind of ['PostToolUse', 'Stop'] as const) {
  if (kind === 'PostToolUse') test(`wave52: identified ${kind} retry after committed child reply loss records once and clears intent`, () => {
    const f = setup(), event = completion(kind, 'event-one');
    const first = f.call(event, f.preload);
    assert.match(first.stdout, /continue.*false/);
    assert.equal(fs.readFileSync(join(f.projectRoot, 'fault-hit'), 'utf8'), 'committed');
    assert.equal(f.count(), 1);
    assert.equal(f.intents().length, 1);
    const retry = f.call(event);
    assert.equal(retry.status, 0, retry.stderr);
    assert.doesNotMatch(retry.stdout, /continue.*false/);
    assert.equal(f.count(), 1);
    assert.deepEqual(f.intents(), []);
    assert.equal(f.call({ hook_event_name: 'PreToolUse', tool_name: 'new_context' }).stdout, '');
  });

  test(`wave52: two successful ${kind} completions preserve identical output`, () => {
    const f = setup();
    for (const id of ['event-one', 'event-two']) {
      const result = f.call(completion(kind, id));
      assert.equal(result.status, 0, result.stderr);
      assert.doesNotMatch(result.stdout, /continue.*false/);
    }
    assert.equal(f.count(), 2);
    assert.deepEqual(f.intents(), []);
  });

  test(`wave52: unidentified ${kind} retry refuses without duplicating a committed event`, () => {
    const f = setup(), event = completion(kind, kind === 'Stop' ? 'continued-turn' : undefined);
    assert.match(f.call(event, f.preload).stdout, /continue.*false/);
    assert.equal(f.count(), 1);
    const files = [join(f.state, 'events.jsonl'), join(f.state, 'HEAD'), join(f.projectRoot, '.context-engine', sid, 'context.md')];
    const before = files.map(path => fs.readFileSync(path));
    const retry = f.call(event);
    assert.match(retry.stdout, /continue.*false/);
    assert.match(retry.stderr, /no stable identity/);
    assert.equal(f.count(), 1);
    files.forEach((path, index) => assert.deepEqual(fs.readFileSync(path), before[index]));
    assert.equal(f.intents().length, 1);
  });
}

test('wave52: multiple Stop completions in one continued turn remain distinct', () => {
  const f = setup();
  const event = { ...completion('Stop', 'same-turn'), stop_hook_active: true };
  for (let i = 0; i < 2; i++) {
    const result = f.call(event);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /continue.*false/);
  }
  assert.equal(f.count(), 2);
  assert.deepEqual(f.intents(), []);
});

test('wave52: a distinct identified event remains distinct while another event awaits exact retry', () => {
  const f = setup();
  assert.match(f.call(completion('PostToolUse', 'event-one'), f.preload).stdout, /continue.*false/);
  assert.doesNotMatch(f.call(completion('PostToolUse', 'event-two')).stdout, /continue.*false/);
  assert.equal(f.count(), 2);
  assert.equal(f.intents().length, 1);
  assert.doesNotMatch(f.call(completion('PostToolUse', 'event-one')).stdout, /continue.*false/);
  assert.equal(f.count(), 2);
  assert.deepEqual(f.intents(), []);
});

for (const legacy of [true, false]) test(`wave52: identified retry refuses ${legacy ? 'legacy' : 'unidentified'} committed completion debt`, () => {
  const f = setup();
  const event = completion('PostToolUse', 'event-one');
  const original = legacy && process.env.CE_WAVE52_LEGACY_HOOK;
  const first = f.call(original ? event : completion('PostToolUse'), f.preload, original || hook);
  assert.match(first.stdout, /continue.*false/);
  assert.equal(fs.readFileSync(join(f.projectRoot, 'fault-hit'), 'utf8'), 'committed');
  assert.equal(f.count(), 1);
  assert.equal(f.intents().length, 1);
  if (legacy && !original) {
    const markerName = f.intents()[0];
    assert.ok(markerName);
    const markerPath = join(f.state, markerName);
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    fs.writeFileSync(markerPath, JSON.stringify({ hash: marker.hash }));
  }
  const files = [join(f.state, 'events.jsonl'), join(f.state, 'HEAD'), join(f.projectRoot, '.context-engine', sid, 'context.md')];
  const before = files.map(path => fs.readFileSync(path));
  const markerBefore = f.intents().map(name => [name, fs.readFileSync(join(f.state, name), 'utf8')]);
  const retry = f.call(event);
  assert.match(retry.stdout, /continue.*false/);
  assert.equal(f.count(), 1);
  files.forEach((path, index) => assert.deepEqual(fs.readFileSync(path), before[index]));
  assert.deepEqual(f.intents().map(name => [name, fs.readFileSync(join(f.state, name), 'utf8')]), markerBefore);
});
