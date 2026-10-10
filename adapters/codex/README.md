# Codex adapter contract

Start with the [agent setup prompt and workflow](../../README.md). Baseline: codex-cli 0.161.0, Node 24+, Linux `/proc`.

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

Every completed tool is checked for a Working Context change before its output is recorded, including tools with unfamiliar path fields. A private notice marker preserves an accepted edit across a failed hook output write. Pending notice work refuses a Stop and a reset before they can hide the edited revision. The refused Stop ends the turn, records nothing and leaves no completion debt, so its reply stays only in the native conversation. The next hook that runs delivers the notice. An ordinary tool hook names the edited revision. The next prompt records itself and names the revision it committed, which still holds the edit. A reset can follow either one. A successful stdout write confirms only hook transport, not ingestion by a model request. Repeated output is possible if acknowledgement fails after the write.

Completed-tool retries use the host's `tool_use_id`, plus `turn_id` when present, as a stable operation identity. The pending intent and core recording share that identity, so a retry after a committed child loses its reply does not append the tool output twice. Distinct tool IDs remain distinct even when their output is identical.

If an earlier pending marker has no verifiable host identity, an identified event cannot be proved distinct from that debt. This includes markers left by older hook versions. The adapter refuses before recording or syncing the event and preserves the marker, Event Log, HEAD and Working Context. Preserve the session data and continue with Context Engine disabled in the native conversation.

Stop events have no unique completion ID in Codex 0.161.0. The host can emit multiple Stops during one turn, so `turn_id` alone cannot identify a retry. Successful Stops record independently. After an ambiguous failed Stop recording, Context Engine preserves the pending intent and refuses an unidentified retry. Preserve the session data and continue with Context Engine disabled in the native conversation. Do not delete the marker to force a retry.

Every hook runs under the 30-second `timeout` that `hooks.json` sets. At that limit, Codex 0.161.0 kills the hook's process group, including any core CLI call in flight. It records the run as failed, so the hook's output has no effect ([command runner](https://github.com/openai/codex/blob/rust-v0.161.0/codex-rs/hooks/src/engine/command_runner.rs)). The hook's own timeouts do not keep every event under that limit. Before any output write, the worst cases are:

- Stop: a 10-second lease wait and a 15-second record call, 25 s.
- Completed tool: a 10-second lease wait, a 7.5-second sync and a 7.5-second record call, 25 s.
- Prompt or reset gate: a 1-second lease wait and one 20-second core call, 21 s.
- PreCompact: a 1-second lease wait and up to three 5-second core calls, 16 s.

Output adds time. The hook retries a write that would block for up to 5 s. If that write fails, the hook writes a refusal under the same bound. Counting one blocked write, the Stop and completed-tool worst cases total 30 s. Process start, module imports and file I/O, which no figure here counts, push them past the limit. A prompt or the reset gate can exceed it when a refusal follows a failed write.

A test holds the lease for 9.5 s and stalls the core to time the Stop case. The completed-tool case needs its first call to succeed just before its own timeout. A shared CI runner cannot time that reliably, so no test covers it.

A Stop or a completed tool killed at the limit leaves its completion intent marker, as the REC-014 kill test shows for a completed tool. The marker refuses every later prompt, Stop, reset and compaction. After a killed completed tool, other tool events still record. After a killed Stop, Context Engine refuses them too.

Only the same tool event, sent again with the same `tool_use_id` and `turn_id`, records once and clears a completed-tool marker. Codex 0.161.0 does not rerun a failed hook, and a Stop has no identity to retry. Either way, the session stays refused until you disable Context Engine for the project.

Managed-file classification resolves tool paths against the project root. A path outside that root or under another directory's `.context-engine` remains ordinary tool output. Setup can remove its final managed instruction block when the file has no trailing newline.
