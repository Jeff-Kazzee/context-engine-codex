// Codex Adapter hook contract: Codex hook stdin JSON in, core CLI calls and a hook decision out.
// Every test runs the real hook script as Codex would (a child process reading stdin) against the
// real core CLI on temp dirs. Nothing touches ~/.codex or the user's XDG state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture, tempDir } from '../../core/testing.ts';
import { CODEX_TOKEN_LIMIT_RESET, setParticipation } from '../../core/index.ts';
import { CODEX_DEFAULT_SHARED_BUDGET, projectCodexToml } from './guidance.ts';
import { createHash } from 'node:crypto';

const HOOK = fileURLToPath(new URL('./plugin/hooks/codex-hook.ts', import.meta.url));
const CLI = fileURLToPath(new URL('../../core/cli.ts', import.meta.url));
const SID = '01a10d16-4780-71c2-803c-80339e0708d3';

type Fixture = ReturnType<typeof fixture>;

/** A temp project with Context Engine enabled (`context-engine enable`): the pilot is opt-in. */
function enabledFixture(): Fixture {
  const f = fixture();
  setParticipation({ ...f, state: 'on' });
  return f;
}

function env(f: Fixture, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...process.env, CONTEXT_ENGINE_CLI: CLI, CONTEXT_ENGINE_STATE_DIR: f.stateDir, CONTEXT_ENGINE: '', ...extra };
}

function hook(f: Fixture, payload: Record<string, unknown>, extraEnv: Record<string, string> = {}) {
  const input = JSON.stringify({ session_id: SID, cwd: f.projectRoot, transcript_path: null, model: 'gpt-6-luna', ...payload });
  const r = spawnSync(process.execPath, [HOOK], { cwd: f.projectRoot, input, encoding: 'utf8', env: env(f, extraEnv) });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const wcPath = (f: Fixture) => join(f.projectRoot, '.context-engine', SID, 'context.md');
const wc = (f: Fixture) => readFileSync(wcPath(f), 'utf8');

test('ordinary tool paths resembling the managed directory remain in Working Context', () => {
  const f = enabledFixture();
  const r = hook(f, { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: '.context-engineering-notes' }, tool_response: 'NORMAL_TOOL_SENTINEL' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(wc(f).includes('NORMAL_TOOL_SENTINEL'));
});
test('shell search mentions of managed paths retain ordinary tool results', () => {
  const f = enabledFixture();
  const r = hook(f, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: "rg '.context-engine/' README.md" }, tool_response: 'SEARCH_SENTINEL' });
  assert.equal(r.status, 0, r.stderr); assert.ok(wc(f).includes('SEARCH_SENTINEL'));
});
test('compound core-read commands retain their additional tool output', () => {
  const f = enabledFixture();
  const r = hook(f, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'context-engine read && printf REQUIRED_SENTINEL' }, tool_response: 'REQUIRED_SENTINEL' });
  assert.equal(r.status, 0, r.stderr); assert.ok(wc(f).includes('REQUIRED_SENTINEL'));
});

test('wave10: direct Node core read avoids copying Working Context tool output into itself', () => {
  const f = enabledFixture(); assert.equal(hook(f, prompt('ORIGINAL_TASK')).status, 0);
  const before = wc(f);
  const r = hook(f, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: `node "${CLI}" read --session ${SID}` }, tool_response: before + 'SELF_COPY_SENTINEL' });
  assert.equal(r.status, 0, r.stderr); assert.equal(wc(f), before);
  const ordinary = hook(f, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: `node "${CLI}" read --session ${SID} && printf EXTRA` }, tool_response: 'COMPOUND_NODE_OUTPUT' });
  assert.equal(ordinary.status, 0, ordinary.stderr); assert.match(wc(f), /COMPOUND_NODE_OUTPUT/);
});

test('wave10: header-only Working Context refuses new_context', () => {
  const f = enabledFixture(); assert.equal(hook(f, prompt('ORIGINAL_TASK')).status, 0);
  writeFileSync(wcPath(f), '[[CTX_TURN 1 role=user]]\n');
  const r = hook(f, { hook_event_name: 'PreToolUse', tool_name: 'new_context', tool_input: {} });
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /not reset|missing or empty/);
});

test('wave10: unavailable-core PreCompact rejects header-only context and allows a valid body', () => {
  const f = enabledFixture(); assert.equal(hook(f, prompt('ORIGINAL_TASK')).status, 0);
  const broken = { CONTEXT_ENGINE_CLI: 'nonexistent-context-engine-test-only' };
  writeFileSync(wcPath(f), '[[CTX_TURN 1 role=user]]\n');
  const refused = hook(f, { hook_event_name: 'PreCompact' }, broken); assert.equal(refused.status, 0); assert.match(refused.stdout, /missing or empty/);
  writeFileSync(wcPath(f), '[[CTX_TURN 1 role=user]]\nVALID_CURRENT_TASK\n');
  const allowed = hook(f, { hook_event_name: 'PreCompact' }, broken); assert.equal(allowed.status, 0); assert.equal(allowed.stdout, '');
});

/** Shared budget 26,000 tokens: minus the 24,000-token Pinned Prefix reserve, halved: 1,000 tokens. */
const SMALL = { CONTEXT_ENGINE_BUDGET_TOKENS: '26000' };
const out = (tokens: number) => 'x'.repeat(tokens * 4);

const prompt = (text: string) => ({ hook_event_name: 'UserPromptSubmit', turn_id: 't1', permission_mode: 'default', prompt: text });

test('UserPromptSubmit records the prompt as a user turn; its only output is the static size readout, never the prompt or file text', () => {
  const f = enabledFixture();
  const r = hook(f, prompt('Fix the flaky test in parser.ts. SECRET_NOTE_42'));
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(out), ['hookSpecificOutput']);
  assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  // Static text with numbers: the per-turn readout (the default budget: Codex's own limit).
  assert.match(out.hookSpecificOutput.additionalContext, /^Context Engine: Working Context ~\d+ tokens of its ~110,400-token budget \(0%; approx\., chars\/4\)\.$/);
  assert.doesNotMatch(r.stdout, /SECRET_NOTE_42|flaky|CTX_TURN/);
  assert.equal(wc(f), '[[CTX_TURN 1 role=user]]\nFix the flaky test in parser.ts. SECRET_NOTE_42\n');
});

test('a reminder fired by a user prompt reaches the model with that prompt (episodes with no tool calls still get them)', () => {
  const f = enabledFixture();
  hook(f, prompt('Task: keep going.'), SMALL);
  const r = hook(f, prompt(`chunk ${out(300)}`), SMALL);
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /passed 25% of its budget\.$/);
  assert.doesNotMatch(r.stdout, /xxxx/);
});

const toolUse = (tool_name: string, tool_input: unknown, tool_response: unknown) => ({
  hook_event_name: 'PostToolUse',
  turn_id: 't1',
  permission_mode: 'default',
  tool_name,
  tool_input,
  tool_response,
  tool_use_id: `call_${Math.random().toString(36).slice(2)}`,
});

test('a copy of the plugin outside the checkout (as Codex caches it) reaches the core through CONTEXT_ENGINE_CLI', () => {
  const f = enabledFixture();
  const cache = join(tempDir('codex-cache'), 'context-engine');
  cpSync(fileURLToPath(new URL('./plugin/', import.meta.url)), cache, { recursive: true });
  const input = JSON.stringify({ session_id: SID, cwd: f.projectRoot, transcript_path: null, model: 'm', ...prompt('From the cache copy.') });
  const r = spawnSync(process.execPath, [join(cache, 'hooks', 'codex-hook.ts')], { cwd: f.projectRoot, input, encoding: 'utf8', env: env(f) });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  assert.equal(wc(f), '[[CTX_TURN 1 role=user]]\nFrom the cache copy.\n');
});

test('PostToolUse records a tool call (input and output) as a tool turn after the prompt', () => {
  const f = enabledFixture();
  hook(f, prompt('List the files.'));
  const r = hook(f, toolUse('Bash', { command: 'ls' }, 'parser.ts\nREADME.md\n'));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
  assert.equal(
    wc(f),
    '[[CTX_TURN 1 role=user]]\nList the files.\n\n[[CTX_TURN 2 role=tool]]\nBash: ls\nparser.ts\nREADME.md\n',
  );
});

test('PostToolUse renders structured tool responses as JSON', () => {
  const f = enabledFixture();
  hook(f, toolUse('apply_patch', { command: '*** Begin Patch\n*** End Patch' }, { success: true, output: 'Done' }));
  assert.match(wc(f), /^\[\[CTX_TURN 1 role=tool\]\]\napply_patch: \*\*\* Begin Patch\n\*\*\* End Patch\n\{"success":true,"output":"Done"\}\n$/);
});

test('a new_context call is recorded as a reset marker, so the next window does not redo recorded steps', () => {
  const f = enabledFixture();
  hook(f, prompt('Step 1: run the tests. Step 2: reset.'));
  hook(f, toolUse('new_context', {}, 'A new context window will start without summarizing conversation history.'));
  assert.match(wc(f), /\[\[CTX_TURN 2 role=tool\]\]\nContext window reset \(new_context\)\. Everything above happened before this point: steps recorded as done are done\. Continue from here\.\n$/);
});

const WC_CMD ='cat ".context-engine/$CODEX_THREAD_ID/context.md"';

test("a tool call on the Working Context commits the model's edit and is not echoed into it", () => {
  const f = enabledFixture();
  hook(f, prompt('Task: rename foo.'));
  const edited = '[[CTX_TURN 1 role=user]]\nTask: rename foo to bar.\n\n[[CTX_TURN 2 role=assistant]]\nPlan: sed.\n';
  writeFileSync(wcPath(f), edited);
  const r = hook(f, toolUse('Bash', { command: WC_CMD }, edited));
  assert.equal(r.status, 0, r.stderr);
  const notice = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  assert.match(notice, /revision 2 was validated/);
  assert.match(notice, /This notice does not deliver its content/);
  assert.doesNotMatch(notice, /rename foo to bar/);
  assert.equal(wc(f), edited, 'reading or editing the Working Context adds no turn (no self-echo)');
  assert.equal(status(f).revision, 2, 'the model edit is committed as a new revision');
});

test('a changed-revision notice contains no editable data and binds subsequent validated read-back', () => {
  const f = enabledFixture();
  assert.equal(hook(f, prompt('CURRENT_USER_REQUIREMENT OLD_MEMORY_SENTINEL')).status, 0);
  const edited = '[[CTX_TURN role=user]]\nCURRENT_USER_REQUIREMENT NEW_MEMORY_SENTINEL\n';
  writeFileSync(wcPath(f), edited);
  const changed = hook(f, toolUse('Write', { file_path: wcPath(f), content: edited }, 'write complete'));
  assert.equal(changed.status, 0, changed.stderr);
  const notice = JSON.parse(changed.stdout).hookSpecificOutput.additionalContext;
  const sha = createHash('sha256').update(edited).digest('hex');
  assert.ok(notice.includes(`--sha ${sha}`));
  assert.doesNotMatch(notice, /NEW_MEMORY_SENTINEL|CURRENT_USER_REQUIREMENT/);
  assert.match(notice, /notice does not deliver/);
  const read = spawnSync(process.execPath, [CLI, 'read', '--session', SID, '--sha', sha], {
    cwd: f.projectRoot, encoding: 'utf8', env: env(f),
  });
  assert.equal(read.status, 0, read.stderr);
  const body = read.stdout.slice(read.stdout.indexOf('\n') + 1);
  assert.equal(body, edited);
  assert.equal(createHash('sha256').update(body).digest('hex'), sha);
  assert.doesNotMatch(body, /OLD_MEMORY_SENTINEL/);
  const unchanged = hook(f, toolUse('Read', { file_path: wcPath(f) }, edited));
  assert.equal(unchanged.status, 0, unchanged.stderr);
  assert.doesNotMatch(unchanged.stdout, /was validated|NEW_MEMORY_SENTINEL/);
  writeFileSync(wcPath(f), edited + 'LATER_EDIT');
  const stale = spawnSync(process.execPath, [CLI, 'read', '--session', SID, '--sha', sha], {
    cwd: f.projectRoot, encoding: 'utf8', env: env(f),
  });
  assert.equal(stale.status, 1);
  assert.match(stale.stdout, /Working Context changed/);
});

test('an emptied Working Context is restored, and the tool result tells the model its edit was not applied', () => {
  const f = enabledFixture();
  hook(f, prompt('Task: keep SECRET_NOTE_42 in mind.'));
  const before = wc(f);
  writeFileSync(wcPath(f), '   \n');
  const r = hook(f, toolUse('Bash', { command: `: > .context-engine/${SID}/context.md` }, ''));
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, 'block', 'block replaces the tool result the model sees with the reason');
  assert.match(out.reason, /not applied \(the file was empty\)/);
  assert.match(out.reason, /Revision 1 .* restored/);
  assert.doesNotMatch(r.stdout, /SECRET_NOTE_42/, 'receipts never echo Working Context content');
  assert.equal(out.hookSpecificOutput?.additionalContext, undefined);
  assert.equal(wc(f), before);
});

test('stale-refs experiment: stale citations are reported with the output of the next Working Context tool call only', () => {
  const f = enabledFixture();
  const on = { CONTEXT_ENGINE_EXPERIMENTS: 'stale-refs' };
  writeFileSync(join(f.projectRoot, 'parser.ts'), 'export const a = 1;\nexport const b = 2;\n');
  const cite = spawnSync(process.execPath, [CLI, 'cite', 'parser.ts#L1-1'], { cwd: f.projectRoot, encoding: 'utf8', env: env(f, on) });
  const marker = cite.stdout.trim();
  assert.match(marker, /^⟦src:parser\.ts#L1@[0-9a-f]{8}⟧$/);
  hook(f, prompt('Task: refactor parser.'), on);
  writeFileSync(wcPath(f), `${wc(f)}\n[[CTX_TURN 2 role=assistant]]\na is defined at ${marker}\n`);
  const fresh = JSON.parse(hook(f, toolUse('Bash', { command: WC_CMD }, 'file text'), on).stdout);
  assert.equal(fresh.decision, undefined, 'a fresh citation does not block the tool result');
  assert.match(fresh.hookSpecificOutput.additionalContext, /Working Context revision 2 was validated/, 'the accepted edit still gets its static notice');
  assert.equal(fresh.hookSpecificOutput.additionalContext.includes(marker), false, 'the notice contains no editable citation payload');
  assert.doesNotMatch(fresh.hookSpecificOutput.additionalContext, /cited reference.*stale/);

  writeFileSync(join(f.projectRoot, 'parser.ts'), 'export const a = 42;\nexport const b = 2;\n');
  assert.equal(hook(f, toolUse('Bash', { command: 'ls' }, 'parser.ts'), on).stdout, '', 'other tool calls are not interrupted');
  const r = hook(f, toolUse('Bash', { command: WC_CMD }, 'file text'), on);
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /1 cited reference is stale/);
  assert.match(out.reason, /Tool output:\nfile text$/, 'the original tool output is kept');
});

const newContext = { hook_event_name: 'PreToolUse', turn_id: 't1', permission_mode: 'default', tool_name: 'new_context', tool_input: {}, tool_use_id: 'call_nc' };

function denial(r: { stdout: string }): string {
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(out.hookSpecificOutput.additionalContext, undefined);
  return out.hookSpecificOutput.permissionDecisionReason as string;
}

test('new_context is allowed when the Working Context is valid, and the pending edit is committed first', () => {
  const f = enabledFixture();
  hook(f, prompt('Task: ship it.'));
  writeFileSync(wcPath(f), '[[CTX_TURN 1 role=user]]\nTask: ship it. Status: tests pass.\n');
  const r = hook(f, newContext);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '', 'an empty answer lets the reset proceed');
  assert.equal(status(f).revision, 2);
});

test('new_context is refused when the Working Context is empty: the file is restored and the model is told why', () => {
  const f = enabledFixture();
  hook(f, prompt('Task: keep SECRET_NOTE_42 in mind.'));
  const before = wc(f);
  writeFileSync(wcPath(f), '');
  const r = hook(f, newContext);
  assert.equal(r.status, 0, r.stderr);
  const reason = denial(r);
  assert.match(reason, /context window was not reset/i);
  assert.match(reason, /the file was empty/);
  assert.match(reason, /call new_context again/);
  assert.doesNotMatch(r.stdout, /SECRET_NOTE_42/);
  assert.equal(wc(f), before, 'restored from the last revision');
});

test('new_context is refused when there is no Working Context and nothing to restore', () => {
  const f = enabledFixture();
  const reason = denial(hook(f, newContext));
  assert.match(reason, /context window was not reset/i);
  assert.match(reason, new RegExp(`\\.context-engine/${SID}/context\\.md`), 'names the path to write');
});

const preCompact = { hook_event_name: 'PreCompact', turn_id: 't1', trigger: 'auto' };
const STOP = { hook_event_name: 'Stop', turn_id: 't1', permission_mode: 'default', stop_hook_active: false };

test('PreCompact (token-limit reset) proceeds silently when the Working Context is valid', () => {
  const f = enabledFixture();
  hook(f, prompt('Task: ship it.'));
  const r = hook(f, preCompact);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
});

test('PreCompact stops the reset with an explanation when the Working Context is missing', () => {
  const f = enabledFixture();
  hook(f, prompt('Task: keep SECRET_NOTE_42 in mind.'));
  const before = wc(f);
  rmSync(wcPath(f));
  const r = hook(f, { ...preCompact, trigger: 'manual' });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.continue, false, 'continue:false is the only PreCompact refusal Codex honours');
  assert.match(out.stopReason, /context window was not reset/i);
  assert.match(out.stopReason, /the file was missing/);
  assert.doesNotMatch(r.stdout, /SECRET_NOTE_42/);
  assert.equal(wc(f), before);
});

// ---- budget and read-back (issue #22) ----


/** The budget text a PostToolUse hook added beside the tool output, or null. */
const added = (stdout: string): string | null => (stdout ? (JSON.parse(stdout).hookSpecificOutput?.additionalContext ?? null) : null);

test('the Working Context budget is half of what the shared budget leaves after the Pinned Prefix, and a reminder rides beside the tool output, which is left alone', () => {
  const f = enabledFixture();
  hook(f, prompt('Task: keep going.'), SMALL);
  const r = hook(f, toolUse('Bash', { command: 'cat big.log' }, out(300)), SMALL);
  const o = JSON.parse(r.stdout);
  assert.equal(o.decision, undefined, 'never a block: in code mode a blocked result reads as a script error (smoke 2)');
  assert.equal(o.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(o.hookSpecificOutput.additionalContext, /^Context Engine: Working Context ~3\d\d tokens of its ~1,000-token budget \(3\d%; approx\., chars\/4\)\.\nContext Engine: the Working Context has passed 25% of its budget\.$/);
  // Default without the variable: Codex's own auto-compact limit for the 272K-window catalog models.
  assert.equal(CODEX_DEFAULT_SHARED_BUDGET, 244_800);
});

test('a tier reminder reaches the model once; between tiers the hook prints nothing', () => {
  const f = enabledFixture();
  hook(f, prompt('Task: keep going.'), SMALL);
  const outs = [300, 20, 20, 60, 60, 60].map((t) => hook(f, toolUse('Bash', { command: 'step' }, out(t)), SMALL).stdout);
  assert.match(added(outs[0]!)!, /passed 25% of its budget/);
  assert.deepEqual(outs.slice(1, 4), ['', '', '']);
  assert.match(added(outs[4]!)!, /passed 50% of its budget/);
  assert.equal(outs[5], '');
});

test('new_context is refused while the Working Context is over its budget, so that its read-back fits in the post-reset window with room to work', () => {
  const f = enabledFixture();
  hook(f, prompt('Task: keep going.'), SMALL);
  hook(f, toolUse('Bash', { command: 'cat big.log' }, out(1200)), SMALL);
  const reason = denial(hook(f, newContext, SMALL));
  assert.match(reason, /context window was not reset/i);
  assert.match(reason, /~1,2\d\d tokens, over its ~1,000-token budget/);
  assert.match(reason, /context-engine read/);
  assert.match(reason, /call new_context again/);
  // Curated below the budget, the reset goes through.
  writeFileSync(wcPath(f), '[[CTX_TURN 1 role=user]]\nTask: keep going. Done: read big.log (nothing relevant).\n');
  assert.equal(hook(f, newContext, SMALL).stdout, '');
});

test('PreCompact (token-limit reset) is not stopped for being over budget: stopping it would abort the turn; the reset is marked in the file', () => {
  const f = enabledFixture();
  hook(f, prompt('Task: keep going.'), SMALL);
  hook(f, toolUse('Bash', { command: 'cat big.log' }, out(1200)), SMALL);
  assert.equal(hook(f, preCompact, SMALL).stdout, '');
  assert.match(wc(f), /\[\[CTX_TURN 3 role=tool\]\]\nContext window reset \(token limit\)\. .*read every part/);
});

/** Every runner event the core logged for the session, in order. */
function loggedEvents(f: Fixture): Array<Record<string, unknown>> {
  const logs = readdirSync(f.stateDir, { recursive: true, encoding: 'utf8' }).filter((p) => p.endsWith(`${SID}/events.jsonl`));
  return logs.flatMap((p) =>
    readFileSync(join(f.stateDir, p), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((e) => e.type === 'runner-events')
      .flatMap((e) => e.events.map((x: { event: Record<string, unknown> }) => x.event)),
  );
}

test('manual compaction retains its distinct trigger and delivery label', () => {
  const f = enabledFixture(); hook(f, prompt('Task: keep going.')); hook(f, { ...preCompact, trigger: 'manual' });
  const event = loggedEvents(f).at(-1)!;
  assert.match(String(event.text), /reset \(manual compaction\)/); assert.match(String(event.delivery), /manual compaction/);
  assert.doesNotMatch(String(event.text), /token.limit/);
});

test("a reset from Codex's own token limit is labelled Compaction-only in the file and the Event Log; a new_context reset is not", () => {
  const f = enabledFixture();
  hook(f, prompt('Task: keep going.'));
  hook(f, preCompact);
  const label = 'Compaction-only (Codex token-limit reset; Working Context read back by the agent)';
  assert.equal(CODEX_TOKEN_LIMIT_RESET.label, label);
  assert.ok(wc(f).includes(`Context window reset (token limit). Delivery Mode: ${label}.`), wc(f));
  const backstop = loggedEvents(f).at(-1)!;
  assert.equal(backstop.delivery, label);
  hook(f, toolUse('new_context', {}, 'ok'));
  const reset = loggedEvents(f).at(-1)!;
  assert.match(String(reset.text), /^Context window reset \(new_context\)\./);
  assert.equal(reset.delivery, undefined);
});

test("the PreCompact that follows a new_context reset adds no token-limit marker, even when the reset marker was merged into the user's turn", () => {
  // As in the pilot: the prompt, then new_context (its marker is a tool turn, which folds into the
  // user turn before it), then Codex runs PreCompact for that same reset.
  const f = enabledFixture();
  hook(f, prompt('Task: keep going.'));
  hook(f, toolUse('new_context', {}, 'ok'));
  hook(f, preCompact);
  const texts = loggedEvents(f).map((e) => String(e.text));
  assert.equal(texts.filter((t) => t.startsWith('Context window reset (new_context)')).length, 1);
  assert.equal(texts.filter((t) => t.startsWith('Context window reset (token limit)')).length, 0, texts.join('\n'));
});

test('urgent reminders never touch a read-back: the part arrives as Codex produced it', () => {
  const f = enabledFixture();
  hook(f, prompt('Task: keep going.'), SMALL);
  hook(f, toolUse('Bash', { command: 'cat big.log' }, out(1200)), SMALL);
  const part = `[Context Engine: Working Context .context-engine/${SID}/context.md, part 1 of 2 (~1,210 tokens in all). Read every part; next: ...]\n${wc(f).slice(0, 100)}`;
  const r = hook(f, toolUse('exec', { command: `context-engine read --session "$CODEX_THREAD_ID"` }, part), SMALL);
  assert.ok(!r.stdout.includes('"decision"'));
  assert.ok(!r.stdout.includes('Tool output'));
});

test('reading the Working Context back with `context-engine read` is not recorded into it (no self-copy)', () => {
  const f = enabledFixture();
  hook(f, prompt('Task: keep going.'));
  const before = wc(f);
  const r = hook(f, toolUse('Bash', { command: `context-engine read --session "$CODEX_THREAD_ID" --part 2` }, `[Context Engine: Working Context ...]\n${before}`));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(wc(f), before);
});

test('the guidance tells the agent to read the file back with the paged read command, every part', () => {
  const toml = projectCodexToml();
  assert.match(toml.table, /context-engine read --session/);
  assert.match(toml.table, /every part/);
  assert.match(toml.top, /context-engine read --session/);
});

test('PreToolUse for other tools is not gated', () => {
  const f = enabledFixture();
  const r = hook(f, { ...newContext, tool_name: 'Bash', tool_input: { command: 'ls' } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
});

test("Stop records the assistant's final message as an assistant turn and lets the turn end", () => {
  const f = enabledFixture();
  hook(f, prompt('What is 2+2?'));
  const stop = STOP;
  const r = hook(f, { ...stop, last_assistant_message: '4' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '', 'never asks Codex to keep the turn going');
  assert.equal(wc(f), '[[CTX_TURN 1 role=user]]\nWhat is 2+2?\n\n[[CTX_TURN 2 role=assistant]]\n4\n');
  hook(f, { ...stop, last_assistant_message: null });
  assert.equal(status(f).revision, 2, 'no assistant message, nothing recorded');
});

test('the kill switch CONTEXT_ENGINE=off turns every hook into a silent no-op, including the gate', () => {
  const f = enabledFixture();
  const off = { CONTEXT_ENGINE: 'off' };
  for (const payload of [prompt('hi'), toolUse('Bash', { command: 'ls' }, ''), newContext, preCompact, { ...STOP, last_assistant_message: 'x' }]) {
    const r = hook(f, payload, off);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, '');
  }
  assert.equal(existsSync(wcPath(f)), false);
  assert.equal(status(f).revision, 0);
});

test('in a project that is not enabled, every hook is a silent no-op and nothing is written', () => {
  const f = fixture();
  for (const payload of [prompt('hi'), toolUse('Bash', { command: 'ls' }, ''), newContext, preCompact, { ...STOP, last_assistant_message: 'x' }]) {
    const r = hook(f, payload);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '', 'no gate refusal: Codex behaves natively');
    assert.equal(r.stderr, '');
  }
  assert.equal(existsSync(join(f.projectRoot, '.context-engine')), false);
  assert.equal(existsSync(f.stateDir), false);
});

test('subagent events are ignored: the Working Context belongs to the root agent only', () => {
  const f = enabledFixture();
  const r = hook(f, { ...prompt('sub task'), agent_id: 'a1', agent_type: 'worker' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
  assert.equal(existsSync(wcPath(f)), false);
});

test('failed prompt and completed-event recording explicitly refuse continuation', () => {
  const f = enabledFixture();
  const broken = { CONTEXT_ENGINE_CLI: join(f.projectRoot, 'no-such-cli.ts') };
  for (const payload of [prompt('hi'), toolUse('Bash', { command: 'ls' }, ''), { hook_event_name: 'Stop', last_assistant_message: 'x' }]) {
    const r = hook(f, payload, broken);
    assert.equal(r.status, 0);
    assert.equal(JSON.parse(r.stdout).continue,false);
    assert.match(r.stderr, /context-engine/);
  }
  const garbage = spawnSync(process.execPath, [HOOK], { input: 'not json', encoding: 'utf8', env: env(f) });
  assert.equal(garbage.status, 0);
  assert.equal(garbage.stdout, '');
});

test('fail closed: if the core is unavailable, the agent-initiated reset (new_context) is refused whatever the file holds, and the model is told why', () => {
  const f = enabledFixture();
  hook(f, prompt('Task: ship it.'));
  const broken = { CONTEXT_ENGINE_CLI: join(f.projectRoot, 'no-such-cli.ts') };
  // A valid file, a file of invalid UTF-8, a file over the hard limit: none can be checked without the core.
  for (const content of [Buffer.from('[[CTX_TURN 1 role=user]]\nTask: ship it.\n'), Buffer.from([0xff, 0xfe, 0x41, 0x0a]), Buffer.from('x'.repeat(2_000_001))]) {
    writeFileSync(wcPath(f), content);
    const reason = denial(hook(f, newContext, broken));
    assert.match(reason, /context window was NOT reset/);
    assert.match(reason, /Context Engine core could not be reached/);
  }
});

test('fail safe: if the core is unavailable, the gate still refuses a reset onto a missing or empty file', () => {
  const f = enabledFixture();
  hook(f, prompt('Task: ship it.'));
  const broken = { CONTEXT_ENGINE_CLI: join(f.projectRoot, 'no-such-cli.ts') };
  writeFileSync(wcPath(f), '\n');
  assert.match(denial(hook(f, newContext, broken)), /context window was NOT reset/);
  rmSync(wcPath(f));
  assert.equal(JSON.parse(hook(f, preCompact, broken).stdout).continue, false);
});

test('missing/throwing core refuses reset, prompt, completed events and compaction; ordinary pre-tool hooks stand aside', () => {
  const f = enabledFixture();
  hook(f, prompt('Task: ship it.'));
  // A checkout that has disappeared, and one whose core module throws while loading.
  const throwing = tempDir('checkout');
  mkdirSync(join(throwing, 'core'));
  writeFileSync(join(throwing, 'core', 'cli.ts'), '');
  writeFileSync(join(throwing, 'core', 'index.ts'), "throw new Error('synthetic module failure');\n");
  for (const cli of [join(tempDir('gone'), 'missing-checkout', 'core', 'cli.ts'), join(throwing, 'core', 'cli.ts')]) {
    const r = hook(f, newContext, { CONTEXT_ENGINE_CLI: cli });
    assert.equal(r.status, 0, r.stderr);
    const reason = denial(r);
    assert.match(reason, /context window was NOT reset/);
    assert.match(reason, /could not be (reached|loaded)/);
    assert.match(reason, /call new_context again/);
    for (const payload of [prompt('hi'), preCompact, toolUse('Bash', { command: 'ls' }, ''), { ...newContext, tool_name: 'Bash' }]) {
      const other = hook(f, payload, { CONTEXT_ENGINE_CLI: cli });
      assert.equal(other.status, 0);
      if(payload.hook_event_name==='UserPromptSubmit'||payload.hook_event_name==='PreCompact'||payload.hook_event_name==='PostToolUse')assert.equal(JSON.parse(other.stdout).continue,false);
      else assert.equal(other.stdout, '', 'ordinary tool hook retains native fallback');
      assert.match(other.stderr, /context-engine codex hook/);
    }
  }
});

test('concurrent hooks for parallel tool calls are serialized: every call is recorded exactly once', async () => {
  const f = enabledFixture();
  hook(f, prompt('Run the checks.'));
  const runs = Array.from({ length: 6 }, (_, i) => {
    const child = spawn(process.execPath, [HOOK], { cwd: f.projectRoot, env: env(f), stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    child.stdin.end(JSON.stringify({ session_id: SID, cwd: f.projectRoot, model: 'm', ...toolUse('Bash', { command: `check-${i}` }, `ok ${i}`) }));
    return once(child, 'exit').then(([code]) => assert.equal(code, 0, stderr));
  });
  await Promise.all(runs);
  const text = wc(f);
  for (let i = 0; i < 6; i++) assert.equal(text.split(`Bash: check-${i}\n`).length - 1, 1, `check-${i} recorded once`);
  assert.equal(status(f).revision, 7);
});

function status(f: Fixture) {
  const r = spawnSync(process.execPath, [CLI, 'status', '--session', SID, '--project', f.projectRoot], { encoding: 'utf8', env: env(f) });
  return JSON.parse(r.stdout) as { revision: number; lock: { pid: number; runner: string } | null };
}

test('the session lock is owned by the runner process through controlled shell ancestry', () => {
  const f = enabledFixture();
  // Keep the shell parent relationship without sourcing machine-wide or user login profiles.
  const input = JSON.stringify({ session_id: SID, cwd: f.projectRoot, transcript_path: null, model: 'm', ...prompt('hello') });
  for (const shell of ['sh', 'bash']) {
    const args = shell === 'bash' ? ['--noprofile', '--norc', '-c'] : ['-c'];
    const r = spawnSync(shell, [...args, `"${process.execPath}" "${HOOK}"; true`], { cwd: f.projectRoot, input, encoding: 'utf8', env: env(f) });
    assert.equal(r.status, 0, r.stderr);
    const s = status(f);
    assert.equal(s.lock?.pid, process.pid, `owner via ${shell}`);
    assert.equal(s.lock?.runner, 'codex');
  }
  assert.equal(status(f).revision, 2, 'both prompts were recorded by the same owner');
});

test('actual shell edit does not resurrect its removed command text or output', () => {
  const f = enabledFixture(); hook(f, prompt('REMOVE_THIS_SENTINEL keep active task'));
  writeFileSync(wcPath(f), wc(f).replace('REMOVE_THIS_SENTINEL', 'RETAINED_SENTINEL'));
  const r = hook(f, toolUse('Bash', { command: 'opaque-script REMOVE_THIS_SENTINEL' }, 'REMOVE_THIS_SENTINEL'));
  assert.equal(r.status, 0, r.stderr); assert.ok(wc(f).includes('RETAINED_SENTINEL')); assert.ok(!wc(f).includes('REMOVE_THIS_SENTINEL'));
});
test('prompt submission surfaces a discarded-edit restore receipt', () => {
  const f = enabledFixture(); hook(f, prompt('prior task'));
  writeFileSync(wcPath(f), ''); const r = hook(f, prompt('continue'));
  assert.equal(r.status, 0, r.stderr); assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /restor/i);
  assert.doesNotMatch(r.stdout, /prior task/);
});
test('unavailable core backstop refuses a synthetic linked Working Context', () => {
  const f = enabledFixture(); hook(f, prompt('active task'));
  const target = join(f.projectRoot, 'synthetic-private-data'); writeFileSync(target, 'SYNTHETIC_TARGET_ONLY');
  rmSync(wcPath(f)); symlinkSync(target, wcPath(f));
  const r = hook(f, { hook_event_name: 'PreCompact' }, { CONTEXT_ENGINE_CLI: 'nonexistent-context-engine-test-only' });
  assert.equal(r.status, 0, r.stderr); assert.equal(JSON.parse(r.stdout).continue, false); assert.doesNotMatch(r.stdout, /SYNTHETIC_TARGET_ONLY/);
  assert.equal(readFileSync(target, 'utf8'), 'SYNTHETIC_TARGET_ONLY');
});
test('supported Unicode Working Context above one MiB remains recordable and resettable', () => {
  const f = enabledFixture(); const r = hook(f, prompt('漢'.repeat(400000)));
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /Working Context/); assert.equal(wc(f).includes('漢'.repeat(100)), true);
  const gate = hook(f, { hook_event_name: 'PreToolUse', tool_name: 'new_context' });
  assert.equal(gate.status, 0, gate.stderr); assert.equal(gate.stdout, '');
});

for (const activation of ['never','disabled','kill-switch']) test('missing checkout leaves inactive reset native: '+activation, () => {
  const f=fixture();if(activation==='disabled')setParticipation({...f,state:'off'});
  if(activation==='kill-switch')setParticipation({...f,state:'on'});
  const r=hook(f,newContext,{CONTEXT_ENGINE_CLI:join(tempDir('missing-checkout'),'core/cli.ts'),...(activation==='kill-switch'?{CONTEXT_ENGINE:'off'}:{})});
  assert.equal(r.status,0);assert.equal(r.stdout,'','inactive reset must remain native');
});
test('unavailable core backstop refuses a sparse file above the multipart read limit', async () => {
  const f=enabledFixture(); hook(f,prompt('SYNTHETIC_TASK'));
  const {truncateSync}=await import('node:fs'); truncateSync(wcPath(f),16*1024*1024+1);
  const r=hook(f,{hook_event_name:'PreCompact'},{CONTEXT_ENGINE_CLI:'nonexistent-context-engine-test-only'});
  assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).continue,false);
});

test('renewed: duplicated supported IPC payload exceeds old 16 MiB floor without denial',()=>{
 const f=enabledFixture();hook(f,prompt('SYNTHETIC_TASK'));
 const fake=join(f.projectRoot,'synthetic-core.ts');
 writeFileSync(fake,"const text='x'.repeat(9*1024*1024);process.stdout.write(JSON.stringify({ok:true,revision:1,workingContextText:text,turns:[{role:'user',text}],budget:{overBudget:false}}));");
 const r=hook(f,newContext,{CONTEXT_ENGINE_CLI:fake});assert.equal(r.status,0,r.stderr);assert.equal(r.stdout,'','a successful synthetic sync must pass IPC');
});

test('wave49: dotted session IDs commit edits and emit a usable read instruction', () => {
  const f = enabledFixture(), id = 'session.1';
  assert.equal(hook(f, { ...prompt('active task'), session_id: id }).status, 0);
  const path = join(f.projectRoot, '.context-engine', id, 'context.md');
  const edited = '[[CTX_TURN role=user]]\nDOTTED_EDIT_SENTINEL';
  writeFileSync(path, edited);
  const result = hook(f, { ...toolUse('Write', { file_path: path }, 'done'), session_id: id });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--session session\.1 --sha/);
  assert.doesNotMatch(result.stdout, /DOTTED_EDIT_SENTINEL|stopReason/);
});

test('wave49: an unknown tool path shape preserves the edit and submits its read notice', () => {
  const f = enabledFixture();
  assert.equal(hook(f, prompt('active task')).status, 0);
  const edited = '[[CTX_TURN role=user]]\nMCP_EDIT_SENTINEL';
  writeFileSync(wcPath(f), edited);
  const result = hook(f, toolUse('mcp__files__write', { target_path: wcPath(f) }, 'DO_NOT_REAPPEND_OUTPUT'));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /revision 2 was validated/);
  assert.equal(wc(f), edited);
  assert.doesNotMatch(result.stdout, /MCP_EDIT_SENTINEL/);
});

async function interruptNoticeOutput(f: Fixture) {
  const child = spawn(process.execPath, [HOOK], { cwd: f.projectRoot, env: env(f), stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  let stderr = '';
  child.stderr.on('data', data => { stderr += data.toString(); });
  // Close the actual pipe before the hook returns. Its child core CLI keeps its own live output pipe.
  child.stdout.destroy();
  child.stdin.end(JSON.stringify({ session_id: SID, cwd: f.projectRoot,
    ...toolUse('Write', { file_path: wcPath(f) }, 'write completed') }));
  const [code] = await exited;
  assert.notEqual(code, 0, stderr);
  assert.match(stderr, /EPIPE|broken pipe/i);
}

test('wave49: failed public stdout retains the accepted read notice for an ordinary hook retry', async () => {
  const f = enabledFixture();
  assert.equal(hook(f, prompt('active task')).status, 0);
  const edited = '[[CTX_TURN role=user]]\nRETRY_EDIT_SENTINEL';
  writeFileSync(wcPath(f), edited);
  await interruptNoticeOutput(f);
  assert.equal(wc(f), edited);
  const retry = hook(f, toolUse('Read', { file_path: 'ordinary.txt' }, 'ordinary output'));
  assert.equal(retry.status, 0, retry.stderr);
  assert.match(retry.stdout, /revision 2 was validated/);
  assert.doesNotMatch(retry.stdout, /RETRY_EDIT_SENTINEL/);
  assert.equal(wc(f), edited);
  const subsequent = hook(f, toolUse('Read', { file_path: 'ordinary.txt' }, 'NEXT_OUTPUT_SENTINEL'));
  assert.equal(subsequent.status, 0, subsequent.stderr);
  assert.doesNotMatch(subsequent.stdout, /was validated/);
  assert.match(wc(f), /NEXT_OUTPUT_SENTINEL/);
  const reset = hook(f, { hook_event_name: 'PreToolUse', tool_name: 'new_context' });
  assert.equal(reset.status, 0, reset.stderr);
  assert.equal(reset.stdout, '');
});

test('wave49: an undelivered read notice blocks a prompt and reset before they can hide its revision', async () => {
  const f = enabledFixture();
  assert.equal(hook(f, prompt('active task')).status, 0);
  const edited = '[[CTX_TURN role=user]]\nPENDING_EDIT_SENTINEL';
  writeFileSync(wcPath(f), edited);
  await interruptNoticeOutput(f);
  const nextPrompt = hook(f, prompt('must wait'));
  assert.equal(JSON.parse(nextPrompt.stdout).continue, false);
  assert.match(nextPrompt.stdout, /read notice/);
  const stop = hook(f, { hook_event_name: 'Stop', last_assistant_message: 'must not hide the pending edit' });
  assert.equal(JSON.parse(stop.stdout).continue, false);
  assert.match(stop.stdout, /read notice/);
  const reset = hook(f, { hook_event_name: 'PreToolUse', tool_name: 'new_context' });
  assert.equal(JSON.parse(reset.stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(wc(f), edited);
});

for (const file_path of ['vendor/.context-engine/ordinary.txt', '.context-engine/../ordinary.txt', '../another-project/.context-engine/file.txt']) {
  test(`wave52: an ordinary resolved path retains its result: ${file_path}`, () => {
    const f = enabledFixture();
    const result = hook(f, toolUse('Read', { file_path }, 'ORDINARY_PATH_RESULT'));
    assert.equal(result.status, 0, result.stderr);
    assert.match(wc(f), /ORDINARY_PATH_RESULT/);
  });
}

test('wave52: a normalized path inside the project managed directory still avoids self-copy', () => {
  const f = enabledFixture();
  assert.equal(hook(f, prompt('ORIGINAL_TASK')).status, 0);
  const before = wc(f);
  const result = hook(f, toolUse('Read', { file_path: `.context-engine/unused/../${SID}/context.md` }, 'SELF_COPY_RESULT'));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(wc(f), before);
});

test('wave52: a symlinked cwd avoids self-copy through canonical and notice paths', () => {
  const f = enabledFixture();
  const link = join(tempDir('alias'), 'project-link');
  symlinkSync(f.projectRoot, link);
  const viaLink = (payload: Record<string, unknown>) => hook(f, { ...payload, cwd: link });
  // The reset gate names the Working Context relative to the cwd the host reported.
  const gate = viaLink({ hook_event_name: 'PreToolUse', tool_name: 'new_context', tool_input: {} });
  const notice = /Working Context (\S+) is missing or empty/.exec(JSON.parse(gate.stdout).hookSpecificOutput.permissionDecisionReason)?.[1];
  assert.equal(notice, relative(link, wcPath(f)));
  assert.equal(viaLink(prompt('ORIGINAL_TASK')).status, 0);
  const before = wc(f);
  for (const file_path of [wcPath(f), notice, `.context-engine/${SID}/context.md`]) {
    const result = viaLink(toolUse('Read', { file_path }, 'SELF_COPY_RESULT'));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(wc(f), before, file_path);
  }
  const ordinary = viaLink(toolUse('Read', { file_path: 'ordinary.txt' }, 'ORDINARY_THROUGH_LINK'));
  assert.equal(ordinary.status, 0, ordinary.stderr);
  assert.match(wc(f), /ORDINARY_THROUGH_LINK/);
});

test('wave52: a symlink into the session directory followed by .. still avoids self-copy', () => {
  const f = enabledFixture();
  assert.equal(hook(f, prompt('ORIGINAL_TASK')).status, 0);
  const sub = join(f.projectRoot, '.context-engine', SID, 'sub');
  mkdirSync(sub);
  symlinkSync(sub, join(f.projectRoot, 'link'));
  const before = wc(f);
  // The shell resolves link before .., so this reads the Working Context itself.
  const result = hook(f, toolUse('Bash', { command: 'cat link/../context.md' }, 'SELF_COPY_RESULT'));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(wc(f), before);
});
