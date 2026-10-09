import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture, tempDir } from '../../../core/testing.ts';
import { FAKE_APP_SERVER } from './testing/fake.ts';

const CLI = fileURLToPath(new URL('./cli.ts', import.meta.url));

/** `script` receives the project root, so scripted turns can write its Working Context. */
function setup(script: (projectRoot: string) => object = () => ({})) {
  const f = fixture();
  const dir = tempDir('fake-codex');
  const logPath = join(dir, 'log.jsonl');
  const scriptPath = join(dir, 'script.json');
  writeFileSync(scriptPath, JSON.stringify(script(f.projectRoot)));
  const run = (args: string[], input?: string) => {
    const r = spawnSync(
      process.execPath,
      [CLI, '--session', 'S1', '--project', f.projectRoot, '--model', 'fake-model', '--codex', JSON.stringify([process.execPath, FAKE_APP_SERVER]), ...args],
      {
        input,
        encoding: 'utf8',
        env: { ...process.env, CONTEXT_ENGINE_STATE_DIR: f.stateDir, FAKE_CODEX_LOG: logPath, FAKE_CODEX_SCRIPT: scriptPath },
        timeout: 30_000,
      },
    );
    const lines = r.stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, any>);
    return { status: r.status, stderr: r.stderr, lines };
  };
  const requests = () =>
    readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, any>)
      .flatMap((e) => (e.modelRequest ? [e.modelRequest as { threadId: string; input: Array<{ role: string; text: string }> }] : []));
  return { run, requests };
}

test('the CLI states its mode and prints one JSON line per turn', () => {
  const t = setup();
  const r = t.run(['--prompt', 'PROMPT_ONE', '--prompt', 'PROMPT_TWO']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(
    r.lines.map((l) => l.event),
    ['start', 'turn', 'turn', 'end'],
  );
  assert.equal(r.lines[0]!.mode, 'Full Replacement per user turn');
  assert.match(r.lines[0]!.workingContext, /\.context-engine\/S1\/context\.md$/);
  assert.deepEqual(
    r.lines.slice(1, 3).map((l) => [l.turn, l.status, l.replaced, l.mode]),
    [
      [1, 'completed', false, 'Full Replacement per user turn'],
      [2, 'completed', true, 'Full Replacement per user turn'],
    ],
  );
});

test('resume in a new process keeps the replaced state', () => {
  const t = setup();
  assert.equal(t.run([], 'PROMPT_ONE\nPROMPT_TWO\n').status, 0);
  const second = t.run(['--prompt', 'PROMPT_THREE']);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.lines[1]!.replaced, true);

  const q3 = t.requests()[2]!;
  assert.equal(q3.input.length, 2, 'the Working Context and the new prompt, nothing else');
  assert.match(q3.input[0]!.text, /^<working_context[\s\S]*PROMPT_ONE[\s\S]*PROMPT_TWO[\s\S]*<\/working_context>$/);
  assert.equal(q3.input[1]!.text, 'PROMPT_THREE');
});

test('a bad invocation prints a JSON error and exits 1', () => {
  const t = setup();
  const r = t.run(['--hard-limit', 'lots']);
  assert.equal(r.status, 1);
  assert.equal(r.lines.at(-1)!.event, 'error');
});

test('[CDX-017] a refused turn exits 3 and skips later prompts', () => {
  const t = setup(projectRoot => ({ turns: [{ reply: 'ONE', writeFile: { path: join(projectRoot, '.context-engine', 'S1', 'context.md'), content: '[[CTX_TURN 1 role=user]]\nBAD\u0000BYTE\n' } }] }));
  const r = t.run(['--prompt', 'PROMPT_ONE', '--prompt', 'PROMPT_TWO', '--prompt', 'PROMPT_THREE']);
  assert.equal(r.status, 3, r.stderr);
  assert.deepEqual(r.lines.map((l) => [l.event, l.status ?? null, l.mode ?? null]), [
    ['start', null, 'Full Replacement per user turn'],
    ['turn', 'completed', 'Full Replacement per user turn'],
    ['turn', 'refused', null],
  ]);
  assert.match(JSON.stringify(r.lines[2]!.receipts), /control/);
  assert.equal(t.requests().length, 1, 'only the first prompt reached the model');
});
