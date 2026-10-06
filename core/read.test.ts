// Read-back in parts (issue #22): after a Codex reset the agent reads its Working Context back as
// tool output, which Codex truncates past a cap. `read` serves the file in parts that each fit
// under that cap, so all of it can be read back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CODEX_TOOL_OUTPUT_CAP_BYTES, openSession, READ_MAX_BYTES, readWorkingContext } from './index.ts';
import { fixture } from './testing.ts';

type F = ReturnType<typeof fixture>;
const CLI = fileURLToPath(new URL('./cli.ts', import.meta.url));

/** A session whose Working Context holds `text` (committed). */
function withText(text: string): F {
  const f = fixture();
  const r = openSession({ ...f, sessionId: 'S1', runner: 'test', hardLimit: 10_000_000 });
  assert.equal(r.status, 'open');
  writeFileSync(r.session.workingContextPath, text);
  r.session.sync();
  r.session.close();
  return f;
}

const body = (out: string) => out.slice(out.indexOf('\n') + 1);
const bytes = (s: string) => Buffer.byteLength(s);

test('every part fits under the Codex tool-output cap, with room to spare', () => {
  assert.equal(CODEX_TOOL_OUTPUT_CAP_BYTES, 40_000);
  assert.ok(READ_MAX_BYTES <= CODEX_TOOL_OUTPUT_CAP_BYTES * 0.85);
});

test('a small Working Context is one part, its text whole after a header naming the part and the size', () => {
  const text = '[[CTX_TURN 1 role=user]]\nTask: fix it.\n';
  const f = withText(text);
  const r = readWorkingContext({ ...f, sessionId: 'S1' });
  assert.equal(r.part, 1);
  assert.equal(r.parts, 1);
  assert.match(r.text, /^\[Context Engine: Working Context \.context-engine\/S1\/context\.md, part 1 of 1 \(~\d+ tokens in all\)\. This is the last part\.\]\n/);
  assert.equal(body(r.text), text);
});

test('a large Working Context reads back whole, in parts that each fit the cap and name the next command', () => {
  const lines = Array.from({ length: 4000 }, (_, i) => `NEEDLE ${String(i).padStart(4, '0')}: ${'é'.repeat(20)} ${'x'.repeat(i % 50)}`);
  const text = `[[CTX_TURN 1 role=tool]]\n${lines.join('\n')}\n`;
  const f = withText(text);
  const first = readWorkingContext({ ...f, sessionId: 'S1' });
  assert.ok(first.parts >= 4, `parts: ${first.parts}`);
  let joined = '';
  for (let p = 1; p <= first.parts; p++) {
    const r = readWorkingContext({ ...f, sessionId: 'S1', part: p, sha: first.sha });
    assert.ok(bytes(`${r.text}\n`) <= READ_MAX_BYTES, `part ${p}: ${bytes(r.text)} bytes`);
    if (p < r.parts) assert.match(r.text.split('\n')[0]!, new RegExp(`part ${p} of ${r.parts} .*Read every part; next: context-engine read --session S1 --part ${p + 1} --sha ${first.sha}\\]$`));
    else assert.match(r.text.split('\n')[0]!, /This is the last part\.\]$/);
    joined += body(r.text);
  }
  assert.equal(joined, text, 'the parts put together are the file, byte for byte');
  // Parts break between lines.
  for (let p = 1; p < first.parts; p++) assert.ok(body(readWorkingContext({ ...f, sessionId: 'S1', part: p, sha: first.sha }).text).endsWith('\n'));
});

test('a single line longer than a part is split without breaking a UTF-8 character', () => {
  const text = `[[CTX_TURN 1 role=tool]]\n${'€'.repeat(30_000)}\n`;
  const f = withText(text);
  const first = readWorkingContext({ ...f, sessionId: 'S1' });
  const n = first.parts;
  assert.ok(n >= 3);
  let joined = '';
  for (let p = 1; p <= n; p++) {
    const r = readWorkingContext({ ...f, sessionId: 'S1', part: p, sha: first.sha });
    assert.ok(bytes(`${r.text}\n`) <= READ_MAX_BYTES);
    assert.doesNotMatch(r.text, /�/);
    joined += body(r.text);
  }
  assert.equal(joined, text);
});

test('each read is counted in the Event Log; a part out of range is an error', () => {
  const f = withText('[[CTX_TURN 1 role=user]]\nhello\n');
  readWorkingContext({ ...f, sessionId: 'S1', part: 1 });
  assert.throws(() => readWorkingContext({ ...f, sessionId: 'S1', part: 2 }), /part 2 of 1/);
  const r = openSession({ ...f, sessionId: 'S1', runner: 'test', hardLimit: 10_000 });
  assert.equal(r.status, 'open');
  const reads = readFileSync(join(r.session.stateDir, 'events.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
    .filter((e) => e.type === 'read');
  r.session.close();
  assert.equal(reads.length, 1);
  assert.deepEqual([reads[0].part, reads[0].parts], [1, 1]);
  assert.equal(typeof reads[0].sha, 'string');
});

test('through the CLI: plain text on stdout, from the project the caller is in (no --project)', () => {
  const f = withText('[[CTX_TURN 1 role=user]]\nhello\n');
  const env = { ...process.env, CONTEXT_ENGINE_STATE_DIR: f.stateDir, CONTEXT_ENGINE_TEST_PROJECT: '' };
  const ok = spawnSync(process.execPath, [CLI, 'read', '--session', 'S1'], { cwd: f.projectRoot, encoding: 'utf8', env });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(body(ok.stdout), '[[CTX_TURN 1 role=user]]\nhello\n');
  const bad = spawnSync(process.execPath, [CLI, 'read', '--session', 'S1', '--part', '9'], { cwd: f.projectRoot, encoding: 'utf8', env });
  assert.equal(bad.status, 1);
  assert.equal(JSON.parse(bad.stdout).ok, false);
  const other = spawnSync(process.execPath, [CLI, 'read', '--session', 'S1', '--project', f.projectRoot], { cwd: f.projectRoot, encoding: 'utf8', env });
  assert.equal(other.status, 1);
});
