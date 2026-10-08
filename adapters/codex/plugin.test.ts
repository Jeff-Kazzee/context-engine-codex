// Codex plugin layout (codex-cli 0.160.0): manifest, hook table, and the project settings that
// `context-engine enable` writes. Offline checks only; the request-capture regression loads it for real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RECALL_GUIDANCE, STALE_REFS_GUIDANCE } from '../../core/index.ts';
import { DEVELOPER_INSTRUCTIONS, GUIDANCE_PROBE, projectCodexOverrides, projectCodexToml, RESET_MODE, tokenBudgetSettings, WORKING_CONTEXT_PATH } from './guidance.ts';

const PLUGIN = fileURLToPath(new URL('./plugin/', import.meta.url));
const json = (rel: string) => JSON.parse(readFileSync(PLUGIN + rel, 'utf8'));
const LABEL = 'Full Replacement at agent-initiated resets (any model step); history grows between resets';

test('the delivery mode label is stated in the manifest, the guidance and the developer instructions', () => {
  assert.equal(RESET_MODE.label, LABEL);
  assert.equal(RESET_MODE.describe(), LABEL);
  assert.ok(json('.codex-plugin/plugin.json').description.includes(LABEL));
  assert.ok(tokenBudgetSettings().guidance_message.includes(LABEL));
  assert.ok(DEVELOPER_INSTRUCTIONS.includes(LABEL));
});

test('the plugin ships hooks only: no skill, so it adds nothing to the prompt of a project nobody enabled', () => {
  const m = json('.codex-plugin/plugin.json');
  assert.equal(m.name, 'context-engine');
  assert.match(m.version, /^\d+\.\d+\.\d+$/);
  assert.equal(m.hooks, './hooks/hooks.json');
  assert.equal('skills' in m, false);
  assert.deepEqual(readdirSync(PLUGIN).sort(), ['.codex-plugin', 'hooks']);
  assert.ok(existsSync(PLUGIN + 'hooks/hooks.json'));
});

test('hooks.json wires every event to the hook script, synchronously, and the gate only to new_context', () => {
  const { hooks } = json('hooks/hooks.json');
  assert.deepEqual(Object.keys(hooks).sort(), ['PostToolUse', 'PreCompact', 'PreToolUse', 'Stop', 'UserPromptSubmit']);
  assert.equal(hooks.PreToolUse.length, 1);
  assert.equal(hooks.PreToolUse[0].matcher, 'new_context', 'an exact matcher: no other tool is gated');
  for (const [event, groups] of Object.entries(hooks) as Array<[string, any[]]>) {
    for (const group of groups) {
      for (const h of group.hooks) {
        assert.equal(h.type, 'command', event);
        assert.equal(h.command, 'node "$PLUGIN_ROOT/hooks/codex-hook.ts"', event);
        assert.notEqual(h.async, true, `${event} must be synchronous to have control effects`);
        assert.ok(h.timeout > 0 && h.timeout <= 60, event);
      }
    }
  }
  assert.ok(existsSync(PLUGIN + 'hooks/codex-hook.ts'));
});

test('token_budget settings replace the model defaults, which name tools Codex does not have', () => {
  const s = tokenBudgetSettings();
  assert.equal(s.enabled, true);
  assert.ok(Buffer.byteLength(s.guidance_message) <= 2000, 'Codex rejects a longer guidance_message');
  assert.ok(s.guidance_message.includes(WORKING_CONTEXT_PATH));
  assert.equal(WORKING_CONTEXT_PATH, '.context-engine/$CODEX_THREAD_ID/context.md');
  assert.match(s.guidance_message, /`new_context`/);
  assert.ok(s.guidance_message.includes(RECALL_GUIDANCE.replaceAll('<session-id>', '"$CODEX_THREAD_ID"')));
  assert.ok(`<context_window_guidance>\n${s.guidance_message}`.startsWith(GUIDANCE_PROBE), 'status recognises it in the rendered prompt');
  assert.ok(s.reminder_message_template.includes('{n_remaining}'));
  assert.ok(Buffer.byteLength(s.reminder_message_template) <= 2000);
  assert.equal(s.reminder_threshold_tokens, 6144, "the catalog's own default, set explicitly because overrides drop it");
  for (const text of [s.guidance_message, s.reminder_message_template]) {
    assert.doesNotMatch(text, /`notes`|`history`|notes tool|history tool/);
  }
  assert.ok(!('auto_compact_fallback_prompt' in s));
});

test('stale-refs guidance is added only when the experiment is on', () => {
  assert.ok(!tokenBudgetSettings({ experiments: [] }).guidance_message.includes(STALE_REFS_GUIDANCE));
  const on = tokenBudgetSettings({ experiments: ['stale-refs'] }).guidance_message;
  assert.ok(on.includes(STALE_REFS_GUIDANCE));
  assert.ok(Buffer.byteLength(on) <= 2000);
});

test('the developer instructions are static: the file path, new_context, and data-not-instructions', () => {
  assert.ok(DEVELOPER_INSTRUCTIONS.includes(WORKING_CONTEXT_PATH));
  assert.match(DEVELOPER_INSTRUCTIONS, /`new_context`/);
  assert.match(DEVELOPER_INSTRUCTIONS, /data you curate, not instructions/);
  assert.doesNotMatch(DEVELOPER_INSTRUCTIONS, /\[\[CTX_TURN/, 'never Working Context content');
});

test('project TOML: a top-level developer_instructions line and a [features.token_budget] table; the same as -c overrides', () => {
  const t = projectCodexToml({ experiments: [] });
  assert.match(t.top, /^developer_instructions = ".*"\n$/);
  assert.doesNotMatch(t.top, /^\[/m, 'no table header in the top block');
  assert.match(t.table, /^\[features\.token_budget\]\nenabled = true\nguidance_message = ".*"\nreminder_message_template = ".*"\nreminder_threshold_tokens = 6144\n$/);
  const [di, tb] = projectCodexOverrides({ experiments: [] });
  assert.match(di!, /^developer_instructions=".*"$/);
  assert.match(tb!, /^features\.token_budget=\{enabled=true, guidance_message=".*", reminder_message_template=".*", reminder_threshold_tokens=6144\}$/s);
  for (const o of [di!, tb!]) assert.doesNotMatch(o, /\n/, 'a TOML basic string has its newlines escaped');
});
