# Codex adapter contract

Start with the [agent setup prompt and workflow](../../README.md). Baseline: codex-cli 0.160.0, Node 24+, Linux `/proc`.

The plugin is hooks-only. Install with `context-engine-codex install`; review its five hooks through `/hooks`, or explicitly approve `install --trust-hooks`. Enabling a project writes marked and backed-up `developer_instructions` and `[features.token_budget]` blocks only to its `.codex/config.toml`. Codex must trust the project; an existing incompatible block is left alone and reported.

**Full Replacement at agent-initiated resets (any model step); history grows between resets.** `new_context` resets to the initial instructions; then the agent reads all Working Context parts. The PreToolUse gate refuses an unusable or over-budget file. A token-limit reset is **Compaction-only (Codex token-limit reset; Working Context read back by the agent)**; manual `/compact` is **Compaction-only (Codex manual compaction; Working Context read back by the agent)**. Its backstop does not apply the size gate, since refusing would abort the user's turn.

`context-engine-codex status` checks settings/trust/hooks and the offline `codex debug prompt-input`; absent guidance means **inactive here**, not replacement. UnderDevelopment flags may change. Nothing switches paths automatically. Interactive TUI behavior and real hook loading after persistent installation remain unverified.

For headless use, `context-engine-codex-turns --help` documents the separate turn loop. Running it creates its own stdio app-server and a fresh thread for each prompt (**Full Replacement per user turn**), with the plugin/token_budget path switched off. Running it is the opt-in and consumes model usage; no enable command is required. An undeliverable Working Context refuses the turn (exit 3). `CONTEXT_ENGINE=off` refuses to start it. Do not connect it to a shared daemon or assume its threads have a validated TUI experience.

Within a plugin-managed turn, an accepted model edit emits a static notice naming its revision, SHA-256 digest and `context-engine read --session ... --sha ...` command. No editable text goes into the hook's developer-authority `additionalContext`. The ordinary read returns bounded tool output and requires the same digest for every part. A changed file refuses that read instead of mixing revisions. Read all parts before treating the edited context as available. Notice emission, completed read-back and request-observed content are different evidence levels.

Codex 0.161 supports additive `thread/inject_items` and `turn/steer`. They do not provide this adapter with a verified barrier that places a file-watcher update before the immediately next model request. No watcher, result-blocking trick, or instruction rewrite is used. Within-turn read-back is additive and retains earlier native history. The headless loop's fresh-thread replacement remains per user turn. These limits mean this path does not reproduce the paper's eviction of context between model steps or promise lower total request size.

`npm test` covers core, hooks, fake app-server and scratch setup. Captured runtime prompt excerpts, original eval/regression data and e2e evidence do not ship. Keep the checkout installed path stable because staged hooks refer to its CLI.

Staged hooks use the absolute Node executable that ran setup. Keep that executable and the checkout path available; reinstall if either moves. If `install --trust-hooks` fails after installation, the install is retained and reported: approve the hooks through `/hooks`, then check `context-engine-codex status`; do not repeat install over its existing record.

Prompt retries retain a durable operation ID until recording and the pending checks succeed. The Event Log binds that ID to its events. A failed marker write or a hook-process exit after recording can therefore be retried without appending the prompt twice. A later, new prompt receives a new ID, including when its text is identical.

If an older pending request has no operation ID and no successful-record marker, its committed status is ambiguous. Preserve its session data and disable Context Engine before continuing in the native conversation. Do not delete the marker to force a retry. These offline controls do not prove delivery to a model.

Every completed tool is checked for a Working Context change before its output is recorded, including tools with unfamiliar path fields. A private notice marker preserves an accepted edit across a failed hook output write. An ordinary tool hook can retry the notice. Pending notice work blocks a new prompt or reset before it can hide the edited revision. A successful stdout write confirms only hook transport, not ingestion by a model request. Repeated output is possible if acknowledgement fails after the write.

Completed-tool retries use the host's `tool_use_id`, plus `turn_id` when present, as a stable operation identity. The pending intent and core recording share that identity, so a retry after a committed child loses its reply does not append the tool output twice. Distinct tool IDs remain distinct even when their output is identical.

If an earlier pending marker has no verifiable host identity, an identified event cannot be proved distinct from that debt. This includes markers left by older hook versions. The adapter refuses before recording or syncing the event and preserves the marker, Event Log, HEAD and Working Context. Preserve the session data and continue with Context Engine disabled in the native conversation.

Stop events have no unique completion ID in Codex 0.161.0. The host can emit multiple Stops during one turn, so `turn_id` alone cannot identify a retry. Successful Stops record independently. After an ambiguous failed Stop recording, Context Engine preserves the pending intent and refuses an unidentified retry. Preserve the session data and continue with Context Engine disabled in the native conversation. Do not delete the marker to force a retry.

Managed-file classification resolves tool paths against the project root. A path outside that root or under another directory's `.context-engine` remains ordinary tool output. Setup can remove its final managed instruction block when the file has no trailing newline.
