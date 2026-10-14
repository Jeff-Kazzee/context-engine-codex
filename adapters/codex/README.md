# Codex adapter contract

Start with the [agent setup prompt and workflow](../../README.md). Baseline: codex-cli 0.161.0, Node 24+, Linux `/proc`.

The plugin is hooks-only. Install with `context-engine-codex install`; review its five hooks through `/hooks`, or explicitly approve `install --trust-hooks`. Enabling a project writes marked and backed-up `developer_instructions` and `[features.token_budget]` blocks only to its `.codex/config.toml`. Codex must trust the project; an existing incompatible block is left alone and reported.

**Full Replacement at agent-initiated resets (any model step), with history growing between resets.** `new_context` resets to the initial instructions. The agent then reads all Working Context parts. The PreToolUse gate refuses an unusable or over-budget file. A token-limit reset is **Compaction-only (Codex token-limit reset, Working Context read back by the agent)**. Manual `/compact` is **Compaction-only (Codex manual compaction, Working Context read back by the agent)**. Its backstop does not apply the size gate, since refusing would abort the user's turn. If its sync fails but the file remains readable, it still attempts the reset marker. An edit committed by that marker's record remains in the Event Log for the next hook to notice.

`context-engine-codex status` checks settings/trust/hooks and the offline `codex debug prompt-input`; absent guidance means **inactive here**, not replacement. UnderDevelopment flags may change. Nothing switches paths automatically. Interactive TUI behavior and real hook loading after persistent installation remain unverified.

For headless use, `context-engine-codex-turns --help` documents the separate turn loop. Running it creates its own stdio app-server and a fresh thread for each prompt (**Full Replacement per user turn**), with the plugin/token_budget path switched off. Running it is the opt-in and consumes model usage; no enable command is required. An undeliverable Working Context refuses the turn (exit 3). `CONTEXT_ENGINE=off` refuses to start it. Do not connect it to a shared daemon or assume its threads have a validated TUI experience.

Within a plugin-managed turn, an accepted model edit emits a static notice naming its revision, SHA-256 digest and `context-engine read --session ... --sha ...` command. No editable text goes into the hook's developer-authority `additionalContext`. The ordinary read returns bounded tool output and requires the same digest for every part. A changed file refuses that read instead of mixing revisions. Read all parts before treating the edited context as available. Notice emission, completed read-back and request-observed content are different evidence levels.

Codex 0.161 supports additive `thread/inject_items` and `turn/steer`. They do not provide this adapter with a verified barrier that places a file-watcher update before the immediately next model request. No watcher, result-blocking trick, or instruction rewrite is used. Within-turn read-back is additive and retains earlier native history. The headless loop's fresh-thread replacement remains per user turn. These limits mean this path does not reproduce the paper's eviction of context between model steps or promise lower total request size.

`npm test` covers core, hooks, fake app-server and scratch setup. Captured runtime prompt excerpts, original eval/regression data and e2e evidence do not ship. Keep the checkout installed path stable because staged hooks refer to its CLI.

Staged hooks use the absolute Node executable that ran setup. Keep that executable and the checkout path available; reinstall if either moves. If `install --trust-hooks` fails after installation, the install is retained and reported: approve the hooks through `/hooks`, then check `context-engine-codex status`; do not repeat install over its existing record.

Prompt retries retain a durable operation ID until recording and the pending checks succeed. The Event Log binds that ID to its events. A failed marker write or a hook-process exit after recording can therefore be retried without appending the prompt twice. A later, new prompt receives a new ID, including when its text is identical.

If an older pending request has no operation ID and no successful-record marker, its committed status is ambiguous. Preserve its session data and disable Context Engine before continuing in the native conversation. Do not delete the marker to force a retry. These offline controls do not prove delivery to a model.

Each completed tool hook syncs the Working Context before it records the tool's output. A tool that read or wrote the managed file is only synced, so it never echoes the file into itself. The tool's own input decides that:

- a path field, such as `file_path` or an MCP tool's `target_path`, that names a managed file
- a plain `cat`, `head`, `tail`, truncate or `context-engine read` command
- a shell command or patch that names `.context-engine` while its sync sees the file change

The hook records every other tool's output, even when its sync commits an edit that a parallel tool made. Codex 0.161.0 runs tools that support parallel calls, such as shell commands, at the same time. Each tool's hook runs when that tool finishes. A shell command that names `.context-engine` while its hook sees a file change is treated as the editor. A script that edits the file without naming it has its command and output recorded like any other tool. If a parallel hook commits a shell edit first, the later edit hook can record its command text too. An append command that contains the appended text can therefore duplicate that text in the Working Context.

Each accepted model edit owes a read notice until the notice reaches hook output. After its sync, a hook finds a notice owed when one is already pending, or HEAD or the Event Log holds a model edit above the last notified revision. It then writes a private pending marker before any call that records past the edit. A prompt syncs before it records for the same reason.

A hook reads the Event Log only past the byte offset that the notice state keeps, and moves that offset past its own appends when it settles. A state from an older hook version without an offset can scan the existing log twice during its first hook. Later hooks return to tail reads. An edit observed by sync becomes a committed revision with a read notice. An in-place edit that lands after sync while the record materializes is instead retained in the Event Log with a restore receipt. It is not the current committed edit. A kill after the Working Context rename can lose that restore receipt while retaining the edit. An editor that renames its own file over the Working Context in the final window can still be overwritten unseen, as the top-level README documents. For committed edits, the read notice survives a failed hook output write, a failed core call and a hook killed between steps, with two exceptions:

- A Stop killed after its record call leaves its intent, which refuses the session as described below. The edit stays owed in the log.
- A hook killed after it marks its notice delivered, and before it exits, loses the notice. Codex applies none of a killed hook's output, and no hook can see whether Codex applied it.

A Stop cannot deliver a notice. It records its reply and leaves an owed notice pending, and the next prompt or tool hook delivers it. Until then the gate denies `new_context` while its committed-edit read notice is pending. Native PreCompact carries that notice through safely readable compaction, subject to the unrecorded-input checks below. A notice owed only through a model edit at HEAD or in the log refuses neither:

- The gate allows the reset. After it, the agent reads the whole Working Context back, which holds the edit. The `new_context` tool's own PostToolUse hook also carries the notice, but Codex runs that hook before the reset, so that notice lands in history the reset discards.
- PreCompact writes the notice as pending before its marker and lets the compaction proceed. The next prompt or tool hook delivers it.

The notice names a revision that still holds the edit:

- A tool hook that touched the managed file names the revision its sync committed.
- An ordinary tool hook records its own output and names the revision that record produced. Until a read-back hook returns the whole current file in the same turn, each ordinary record refreshes that notice to its new revision. This covers parallel tools whose hooks run one after another before the model sees their outputs. The hook recognizes the complete file in raw text or an `output` or `stdout` field. Partial, paged, or transformed results remain unacknowledged and can produce extra notices in that turn.
- A prompt names the revision it committed. An edit made between turns, which no tool hook saw, gets its notice this way.

A successful stdout write shows emitted bytes. Codex applies hook output after a successful exit. Committed-edit read notices retain the post-mark kill limitation above. Durable restore notices stay pending and can repeat across later hooks.

`notice-sweep.test.ts` checks these rules. Its faults are kills at each hook step, a closed stdout, sync calls that fail with and without committing, and an edit written while a record call runs. It runs parallel tools' hooks one after another and observes their combined outputs, as Codex does when the tools finish at different times. Every fault in a cell must fire, and `SWEEP_PRUNED=1` checks that no pruned fault fires. After a fault the sweep checks the notice and the tool outputs before it sends any event twice. It then sends a faulted tool event again to show the documented way to clear that debt, which Codex does not do on its own. `notice-review.test.ts` checks staggered notice read-back, bounded Event Log reads, and a single compaction refusal after a failed final check.

Completed-tool retries use the host's `tool_use_id`, plus `turn_id` when present, as a stable operation identity. The pending intent and core recording share that identity, so a retry after a committed child loses its reply does not append the tool output twice. The intent stores a SHA-256 digest of the host IDs, so its size does not depend on their length. Distinct tool IDs remain distinct even when their output is identical.

If an earlier pending marker has no verifiable host identity, an identified event cannot be proved distinct from that debt. This includes markers left by older hook versions. The adapter refuses before recording or syncing the event. It preserves the earlier marker, Event Log, HEAD and Working Context, and keeps the refused event's own pending intent. That intent blocks prompts and resets even after the earlier marker clears, until the exact retry records the event once. Preserve the session data and continue with Context Engine disabled in the native conversation.

Stop events have no unique completion ID in Codex 0.161.0. The host can emit multiple Stops during one turn, so `turn_id` alone cannot identify a retry. Successful Stops record independently. After a Stop publishes its intent, a refusal or failed recording preserves that intent and refuses an unidentified retry. This includes a Stop refused before recording because another completion acquired debt while it waited. Its unrecorded reply remains debt after the other marker clears, so prompts and resets stay refused. Preserve the session data and continue with Context Engine disabled in the native conversation. Do not delete the marker to force a retry.

Every hook runs under the 30-second `timeout` that `hooks.json` sets. At that limit, Codex 0.161.0 kills the hook's process group, including any core CLI call in flight. It records the run as failed, so the hook's output has no effect ([command runner](https://github.com/openai/codex/blob/rust-v0.161.0/codex-rs/hooks/src/engine/command_runner.rs)). The hook's own timeouts do not keep every event under that limit. Before any output write, the worst cases are:

- Stop: a 10-second lease wait and a 15-second record call, 25 s.
- Completed tool: a 10-second lease wait, a 7.5-second sync and a 7.5-second record call, 25 s.
- Prompt: a 1-second lease wait, a 5-second sync and a 15-second record call, 21 s.
- Reset gate: a 1-second lease wait and one 20-second sync, 21 s.
- PreCompact: a 1-second lease wait and up to three 5-second core calls, 16 s.

Output adds time. The hook retries a write that would block for up to 5 s. If that write fails, the hook writes a refusal under the same bound. Counting one blocked write, the Stop and completed-tool worst cases total 30 s. Process start, module imports and file I/O, which no figure here counts, push them past the limit. A prompt or the reset gate can exceed it when a refusal follows a failed write.

A test holds the lease for 9.5 s and stalls the core to time the Stop case. The completed-tool case needs its first call to succeed just before its own timeout. A shared CI runner cannot time that reliably, so no test covers it.

A Stop or a completed tool killed at the limit leaves its completion intent marker, as the REC-014 kill test shows for a completed tool. The marker refuses every later prompt, Stop, reset and compaction. After a killed completed tool, other tool events still record. After a killed Stop, Context Engine refuses them too.

Only the same tool event, sent again with the same `tool_use_id` and `turn_id`, records once and clears a completed-tool marker. Codex 0.161.0 does not rerun a failed hook, and a Stop has no identity to retry. Either way, the session stays refused until you disable Context Engine for the project.

Managed-file classification resolves tool paths against the project root. It compares each path as given and in canonical form, so a cwd reached through a symlink still recognizes the Working Context by its canonical path or by the relative path that the hook's notices name. It also resolves each path the way the filesystem does, so a symlink followed by `..` is classified by the directory it actually reaches. A path outside that root or under another directory's `.context-engine` remains ordinary tool output. Setup can remove its final managed instruction block when the file has no trailing newline.


Restore notices created by this version carry unique durable intent IDs. A restore intent is written before file publication, so replay says restoration was requested and requires a reread. It does not claim that the following rename completed. The rejected edit is retained separately. Sync and unmaterialized runner-append recovery both reoffer pending notices even when the file already matches HEAD, without rewriting it just to replay a notice. Older ID-less restored rows remain readable, but their historical lost notices and delivery outcomes are not reconstructed.

Each new restore attempt has a distinct notice ID, including identical rejected bytes at one revision. Confirmation of an earlier attempt cannot clear a later one. Local samples in one materialization are deduplicated. An ambiguous crash retry can create another attempt and retain another rejected-edit row. Retention in that case is at least once, not exactly once. Invalid-sync recovery of an already-current file needs no new restore attempt. An unmaterialized append can still recover its preserved predecessor and create another independently confirmable intent, even when the public file already matches HEAD.

Each result represents at most 64 pending IDs and reports the total pending count. Model-facing output uses one bounded static summary. The remaining IDs stay durable and advance after successful confirmation of the represented batch. CLI stdout confirms its own transport by default. Native Codex hooks defer that confirmation and keep notices pending. Other adapter transports confirm only carried IDs against the offered session generation after their observed transport succeeds.

Acknowledgment validates the durable HEAD/log boundary and IDs without syncing, materializing, repairing the ignore file, or rewriting Working Context. Unknown IDs or a stale owner generation refuse before confirmation. A repeated confirmed ID is harmless.

The disposable recovery checkpoint moves from version 4 to 5 to cache pending intents. Older checkpoints rebuild from the Event Log. HEAD and historical log records are not migrated.

Native Codex hooks do not confirm restore notices. Codex accepts hook output only after a successful exit, and the hook receives no acceptance acknowledgment. A complete stdout write cannot prove that acceptance. Prompt and tool hooks reoffer durable pending notices. A reset refusal can carry the same warning. Successful native compaction keeps it for the next prompt or tool hook. The represented batch can repeat indefinitely, with additional IDs queued.

Native hooks keep restore IDs pending because the host provides no acceptance callback. Warning delivery and reset safety have separate state. An agent reset can proceed after a complete current Working Context read observed in tool output. The barrier binds the owner generation, revision, content digest and the full pending restore-attempt set. Sequential plain or framed CLI read parts must reconstruct the complete current file. Partial reads, changed content, a new owner or another restore attempt invalidate the barrier.

The barrier does not prove model ingestion or confirm restore IDs. Native manual and token-limit compaction require safely readable, nonempty UTF-8 context within the read limit. Unrecorded input debt refuses compaction. Previously pending warning or committed-edit notices alone do not abort that compaction. The next prompt or tool hook reoffers those notices. After compaction, read every part in the next window.

PreCompact refuses a restoration it first discovers until it observes a complete current restored-state read. The adapter writes a private read intent before the core call. A retry or hook killed after sync cannot bypass that read. Partial or stale reads, a new owner and another restore attempt do not clear it. An interrupted compaction check can conservatively require a read even if no restoration occurred.

A separate caller with observed transport can confirm represented IDs against their offered owner generation. Do not confirm them merely to dismiss a warning. A represented batch can still repeat indefinitely while the host has no acknowledgment API.

The turn loop keeps its separate confirmation after a successful turn/start reply. Refused injection and an uncertain or lost start reply leave notices pending. Delivery is at least once under retry. No exactly-once display or model ingestion guarantee is made. Offline synthetic controls do not establish installed host acceptance.


Confirmed restore history uses a disposable lookup with 64 bounded shards. Each shard holds compact identity and row-offset evidence, not rejected edit payloads. A cold rebuild streams compact rows, then processes one shard at a time. Only pending notice bodies remain in session memory.

The lookup binds its source log identity, size and timestamps. Shard hashes and original row checks protect lookups. Missing or safely readable invalid cache data rebuilds from the retained Event Log. Unsafe or oversized cache files refuse with source evidence preserved. Warm refresh processes appended rows. Confirmation still performs the full continuous runner-evidence check. This repair does not make that independent integrity scan incremental.

A serialized shard cannot exceed 4 MiB. Capacity exhaustion refuses with the source evidence retained. Rebuild scratch space grows with compact historical rows and is removed after a completed or failed rebuild. Pending notices, rejected edits and original recovery history are never deleted by this lookup.
