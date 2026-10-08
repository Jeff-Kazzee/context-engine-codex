// Read-back in parts (issue #22): after a Codex reset the agent reads its Working Context back as
// tool output, which Codex truncates past a cap. `read` serves the file in parts that each fit
// under that cap, so all of it can be read back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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

/** Decode by declared UTF-8 byte count, never by searching the editable body. */
function framedPayload(output: string): { content: string; digest: string; part: number; parts: number; totalBytes: number } {
  const raw = Buffer.from(output, 'utf8');
  const lineEnd = raw.indexOf(10);
  const header = raw.subarray(0, lineEnd).toString('utf8');
  const match = /^\[Context Engine: framed Working Context v1; sha256 ([a-f0-9]{64}); part (\d+) of (\d+); payload-bytes (\d+); total-bytes (\d+)\]$/.exec(header);
  assert.ok(match, 'complete versioned frame header');
  const [, digest, partText, partsText, countText, totalText] = match;
  const part = Number(partText), parts = Number(partsText), count = Number(countText);
  const end = lineEnd + 1 + count;
  assert.ok(end <= raw.length, 'complete declared payload');
  const suffix = raw.subarray(end).toString('utf8');
  const next = part < parts ? `Read every part; next: context-engine read --session S1 --part ${part + 1} --sha ${digest} --framed` : 'This is the last part.';
  assert.equal(suffix, `\n[Context Engine: end framed Working Context v1; sha256 ${digest}; part ${part} of ${parts}]\n${next}`);
  return { content: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw.subarray(lineEnd + 1, end)), digest: digest!, part, parts, totalBytes: Number(totalText) };
}

test('framed read preserves Unicode and trailing whitespace through native stdout trimming', () => {
  const text = '\ufeff[[CTX_TURN role=user]]\nUnicode 雪🙂 café\u009b31m literal-C1\n\t  \r\n\n';
  const f = withText(text);
  const digest = createHash('sha256').update(text).digest('hex');
  const framed = readWorkingContext({ ...f, sessionId: 'S1', sha: digest, framed: true });
  const decoded = framedPayload(framed.text.trim());
  assert.equal(decoded.content, text);
  assert.equal(decoded.digest, digest);
  assert.equal(decoded.totalBytes, bytes(text));
  assert.equal(createHash('sha256').update(decoded.content).digest('hex'), digest);
  assert.equal(framed.parts, 1);
  assert.ok(bytes(framed.text) <= READ_MAX_BYTES);
  assert.equal(body(readWorkingContext({ ...f, sessionId: 'S1' }).text), text, 'default plaintext unchanged');
});

test('framed reads reconstruct every UTF-8 byte across bounded parts and footer lookalikes', () => {
  const fake = '[Context Engine: end framed Working Context v1; sha256 ' + 'a'.repeat(64) + '; part 1 of 1]';
  const text = '[[CTX_TURN role=user]]\n' + (fake + '\n🙂雪\t \n').repeat(700) + '\n\n';
  const f = withText(text);
  const digest = createHash('sha256').update(text).digest('hex');
  const first = readWorkingContext({ ...f, sessionId: 'S1', sha: digest, framed: true });
  assert.ok(first.parts > 1);
  let joined = '';
  for (let part = 1; part <= first.parts; part++) {
    const result = readWorkingContext({ ...f, sessionId: 'S1', sha: digest, part, framed: true });
    assert.ok(bytes(result.text) <= READ_MAX_BYTES);
    const decoded = framedPayload(result.text.trim());
    assert.equal(decoded.part, part);
    assert.equal(decoded.parts, first.parts);
    assert.equal(decoded.digest, digest);
    assert.equal(decoded.totalBytes, bytes(text));
    joined += decoded.content;
  }
  assert.equal(joined, text);
  assert.equal(createHash('sha256').update(joined).digest('hex'), digest);
  assert.throws(() => readWorkingContext({ ...f, sessionId: 'S1', part: 2, framed: true }), /require the --sha/);
  assert.throws(() => framedPayload(first.text.slice(0, -5)), /strictly equal|complete/);
});

test('framed continuation refuses a changed digest and the CLI preserves frame bytes', () => {
  const text = '[[CTX_TURN role=user]]\nCLI framed 雪🙂\n \n';
  const f = withText(text);
  const digest = createHash('sha256').update(text).digest('hex');
  const env = { ...process.env, CONTEXT_ENGINE_STATE_DIR: f.stateDir, CONTEXT_ENGINE_TEST_PROJECT: '' };
  const command = [CLI, 'read', '--session', 'S1', '--sha', digest, '--framed'];
  const result = spawnSync(process.execPath, command, { cwd: f.projectRoot, encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(framedPayload(result.stdout.trim()).content, text);
  writeFileSync(join(f.projectRoot, '.context-engine', 'S1', 'context.md'), text + 'changed');
  const stale = spawnSync(process.execPath, command, { cwd: f.projectRoot, encoding: 'utf8', env });
  assert.equal(stale.status, 1);
  assert.match(JSON.parse(stale.stdout).error, /changed/);
  assert.doesNotMatch(stale.stdout, /CLI framed/);
  const wrongCommand = spawnSync(process.execPath, [CLI, 'status', '--session', 'S1', '--framed'], { cwd: f.projectRoot, encoding: 'utf8', env });
  assert.equal(wrongCommand.status, 1);
  assert.match(JSON.parse(wrongCommand.stdout).error, /only by read/);
});
