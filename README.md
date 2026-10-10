# Context Engine for Codex

An experimental, opt-in plugin that lets your agent edit its **Working Context** with ordinary tools. This repository ships only the Codex adapter and a pinned shared core. It starts **off in every project**. No default-on recommendation or accuracy gain is claimed.

**Full Replacement at agent-initiated resets (any model step); history grows between resets.** The agent must call `new_context`, then read every part of its Working Context. A token-limit reset is **Compaction-only (Codex token-limit reset; Working Context read back by the agent)**; manual `/compact` is **Compaction-only (Codex manual compaction; Working Context read back by the agent)**.

An accepted edit now produces a static revision and digest notice with an exact read-back command. The notice does not contain or deliver editable context. Reading every part with that digest can add the edited content as tool output within the same user turn. This is additive input for a later continuation and retains older native history. It does not reproduce per-step context eviction or guarantee a smaller request. Partial reads, a changed digest, and a file path alone do not establish delivery.

**Source approval and installation acceptance:** changes target `dev`, then move to `main` after the applicable acceptance gates and owner authorization. Verify the exact head commit, its CI results and independent review before an installation trial. A branch name or an earlier passing commit does not establish acceptance of this snapshot.

Ordinary-profile persistent plugin loading, interactive delivery and bounded long-session functional acceptance remain unverified. These checks must prove the documented next-request and read-back behavior on the supported host. Comparative performance research is outside these release gates. Offline source checks do not make provider calls or change host configuration.

## Give this prompt to your agent to set it up

Copy the following prompt, replacing the project placeholder before sending it:

```text
Set up Context Engine for Codex from
https://github.com/Jeff-Kazzee/context-engine-codex
for this project: <absolute project path>.
Select the exact commit approved for this installation trial. Verify its CI,
independent source review and owner authorization before installation. Do not
infer approval from a branch name or reuse evidence for a different commit. Read the CURRENT README.md, AGENTS.md, PROVENANCE.md, SOURCE.json and
adapters/codex/README.md before executing anything. Verify the actual OS,
Node version, codex version and available plugin/mod commands against those
docs and their CLI help. The inherited compatibility baseline is codex-cli 0.160.0 (token_budget under development);
do not silently install/downgrade a runner or assume another version works.
If access, licensing or runtime support is blocked, stop and report the reason.
Explain config changes and hook trust, then use normal approval controls.
Never read/copy authentication files, tokens or raw private captures. Use the
runner's existing login without inspecting it; no API-key or proxy fallback.
Use a fresh disposable test project FIRST. Install only this runner's plugin,
leave per-step/stale-refs experiments off, enable only the test project, and
run context-engine-codex status there. An installed plugin or a file write is not proof.
Using non-sensitive sentinels, prove a Working Context edit changes what the
NEXT REQUEST contains at the documented delivery boundary. If request-level
evidence is unavailable, explicitly report that acceptance as unverified;
do not expand logging/permissions or claim success. Do not run costly evals.
After the test passes and I approve the target-project scope, enable only the
named project and report exact mode, versions, commands, config/backups changed,
evidence, gaps and disable/uninstall steps. Preserve unrelated work.
```

The [CI workflow](.github/workflows/ci.yml) checks the exact PR source commit on three hosts with Node 24.21.0. Its platform coverage is:

| Host | Maintained coverage | Stateful support |
| --- | --- | --- |
| Linux | Core, setup and adapter suites | Supported with the documented Linux requirements |
| Windows | Pure operations and refusal before state or setup mutation | Unsupported |
| macOS | Pure operations and refusal before state or setup mutation | Unsupported |

Actual Windows and macOS jobs passed on 2026-10-08 in [the initial CI run](https://github.com/Jeff-Kazzee/context-engine-codex/actions/runs/37730433891) at `1e63576690d435cbec35f8cc192b49fcdb4fa798`. These baseline results do not validate later commits. Each updated PR head requires its own successful CI. Offline contract checks do not prove provider delivery, model behavior or interactive acceptance.

## 1. Check compatibility before installing

The shared core separates host operations through `core/platform-contract.ts`. Its Linux backend inspects actual handles and targets, reports ownership and private-access facts, and owns private creation and permission changes. Context parsing, rendering and token estimates remain usable without selecting a host backend. A future backend must preserve directory confinement, exclusive lock publication, process identity, private access and durability before stateful use. Extracting this contract does not implement Windows or macOS adapters or establish live delivery acceptance.

Shared core 0.1.5 uses the full SHA-256 of the canonical project path for private state and participation keys. Legacy 0.1.0 directories and backups are preserved, but are not automatically migrated or merged. Uninstall an old installation using its original checkout/CLI first; retain its backups and session data. After coordinated runner updates, re-enable a fresh disposable project and start a fresh session. Do not mix 0.1.0 with 0.1.5 under a shared `CONTEXT_ENGINE_STATE_DIR`; use a separate, consistently configured state root for a trial. Existing legacy data remains available through the old checkout with its old state root. Valid full-digest keys from 0.1.1 remain unchanged in 0.1.2, 0.1.3 and 0.1.5.

- Linux with `/proc` mounted and Node **24 or newer** is the supported stateful target. Native Windows and macOS have no verified host backend. Stateful storage, locking, install and uninstall refuse with `CE_UNSUPPORTED_PLATFORM` before mutation. Use the original supported Linux environment and checkout to remove a prior installation. Do not relax confinement checks or sandbox permissions.
- Inherited compatibility baseline: **codex-cli 0.160.0 (token_budget under development)**. These are observed baseline versions, not a guarantee that every machine or newer version works. Inspect `codex --version`, `codex --help` and its plugin help first.
- A custom `CONTEXT_ENGINE_STATE_DIR` must be an absolute path, identical in the setup shell and runner launch environment. Relative state roots are refused rather than resolved differently for each project or hook cwd.
- Setup now requires each ledger's backup copies to remain inside that ledger's own snapshot. Older project-repair ledgers that reference sibling snapshots are refused. Before updating an existing installation, uninstall with its original checkout and preserve its backups; do not edit a refused ledger to bypass this check.
- Use a dedicated state directory owned by your user with private permissions (`0700`). Existing shared or linked state directories are refused without changing their permissions; never point the override at `/tmp` itself or a shared mount root.
- Existing normal runner login. Setup never opens runner authentication files or uses their credentials. It reads tracked configuration and refuses recognized credential-bearing keys before making backup copies. This is not a universal secret detector: secrets under innocuous keys or in arbitrary text may escape detection. Never inspect `~/.claude/.credentials.json` or `~/.codex/auth.json`; use normal runner authentication if needed.
- Persistent install changes runner configuration through its own plugin commands. Review changes and backups first; ordinary tool permissions and user approvals remain in control.

```sh
node --version
codex --version
codex plugin --help
```

## 2. Install this adapter and try a disposable project

These commands change configuration. Run them only after the preflight above, in a supported environment where you approve plugin installation. Keep the checkout at its installed path: hook commands refer to it. If the sibling adapter is already installed, first choose shared or isolated participation as described below; do not run `enable` until that scope is approved.

```sh
git clone https://github.com/Jeff-Kazzee/context-engine-codex.git
cd context-engine-codex
# Replace APPROVED_COMMIT with the exact reviewed commit approved for this trial.
git checkout --detach APPROVED_COMMIT
git rev-parse HEAD
npm ci
npm link
context-engine-codex install
# Replace this path with a NEW disposable project, not the repo checkout.
mkdir -p /tmp/context-engine-codex-trial
cd /tmp/context-engine-codex-trial
context-engine-codex enable
context-engine-codex status
```

No runner binary is installed by these commands. `install` defaults to **Codex only** and refuses the other runner flag. `enable` covers the selected directory and its subdirectories. This repository does not install or change Claude Code configuration. Shared participation can activate an already-installed sibling adapter; check the scope below before enabling.

Both distributions vendor the same core. They retain `context-engine` for compatible session `read`/`recall`/`show` commands. Linking the second checkout replaces that generic PATH alias; **always use `context-engine-codex` for install, enable, status, disable and uninstall**. The runtime aliases remain distinct. Default state/participation storage is shared; if both plugins are installed, enabling a project may activate both. Use a consistent, separate `CONTEXT_ENGINE_STATE_DIR` in each runner's launch environment and matching setup shell when you require separate participation. Never mix core versions under a shared generic alias.

Trust the test project through Codex's normal trust prompt. Review/approve the five plugin hooks with `/hooks`. Alternatively, only after approving that scope, run `context-engine-codex uninstall`, then `context-engine-codex install --trust-hooks`, then re-enable only the trial project; the flag writes trust for these five hooks through a dedicated stdio app-server. `status` checks project settings, project trust, plugin enablement, current hook trust hashes from a read-only `hooks/list` and offline `codex debug prompt-input`. If any fails it reports **inactive here** and its reason. Report an inactive path as inactive.

## 3. Prove delivery, then enable your intended project

Use harmless, unique strings such as `CE_OLD_TEST` and `CE_NEW_TEST`. Preserve the current human request and the runner instructions, tools and permissions. Test the intended delivery mode explicitly.

For within-turn Injection, edit the committed Working Context and inspect the static revision-and-digest notice. That notice is not content delivery. Run its exact `context-engine read` command and read every part with the same digest. Inspect the following native request for the complete new content in ordinary tool output. Earlier native history remains. Partial reads or a changed digest do not pass.

For Full Replacement at agent-initiated resets, use an agent-initiated `new_context`, then complete the digest-bound read-back. Verify that the old native window has been removed and the new request carries the intended file as tool output. Native token-limit and manual compaction use their separately documented Compaction-only paths.

Inspect only authorized, scoped request evidence from a disposable project. A changed file, active status, prepared packet, hook return or model statement does not establish delivery. If safe request inspection is unavailable, report delivery as **unverified** and keep the test scope.

After you accept the result, move to the intended project and run `context-engine-codex enable`, then `context-engine-codex status`. Preserve the original task, user control and ordinary approval boundaries. Editable context is user data and can retain prompt injections; it does not gain system/developer authority.

Useful agent instructions in an enabled session:

```text
Keep the current request, verified decisions and next step in your Working
Context. Preserve source pointers when offloading large tool outputs. After a
reset, read the current file completely and continue without repeating done work.
```

From that project, replace placeholders with the actual session and event IDs:

```sh
context-engine read --session <session-id>
context-engine recall --session <session-id> decision
context-engine show --session <session-id> <event-id>
```

`read` names every next part when a file needs paging. It refuses files above 16 MiB before loading their payload; reset backstops also refuse files above this delivery limit; offload large content with source pointers instead of relying on unbounded paging. Invalid UTF-8 is refused by reads and citations. `recall` and `show` are limited to the caller's project, with bounded output. Recall may report `accounting: skipped` if the Event Log cannot be written in a sandbox; that path is unit-tested, not established by a real sandbox session.

## 4. Roll back or uninstall

```sh
# Run in the project enabled above:
context-engine-codex disable
CONTEXT_ENGINE=off codex
# Removes this runner's adapter; retains session data:
context-engine-codex uninstall
# Run in its checkout only when removing its PATH links:
npm unlink --global context-engine-codex
```

Claude enable/disable and kill-switch changes apply to new sessions; Codex checks participation at each hook. Backups precede config writes. Configuration with recognized credential-bearing keys is refused before any before/after backup copies. Conservative TOML inspection also refuses escaped keys, inline tables and multiline nonstring forms; keep secrets in normal runner authentication rather than tracked configuration. Conflicting project guidance or unsafe paths refuse activation and leave this project disabled; re-enable repairs missing managed blocks while preserving the original rollback bytes. Unchanged configuration is restored byte for byte; if other tools changed it, uninstall removes only Context Engine entries and reports the backup location. Project rollback runs before global removal, so a refused rollback retains installation metadata for retry. Review partial failures before retrying. Unlinking the CLI alone does not uninstall plugin configuration.

Working Contexts live in `<project>/.context-engine/<session>/`, with managed directories private (`0700`) and the file private (`0600`). Existing user-owned managed directories/files are tightened on open; unsafe links, credentials and shared state roots are refused. Setup also refuses nonprivate state roots before changing runner configuration. If an interrupted runner append committed a revision before writing the file, recovery delivers that revision and preserves an intervening stale-file edit in the Event Log with a restore notice. Revisions, the Event Log, participation and install backups live under `$XDG_STATE_HOME/context-engine` (default `~/.local/state/context-engine`; `CONTEXT_ENGINE_STATE_DIR` overrides). Runner homes honor `CLAUDE_CONFIG_DIR`/`CODEX_HOME`. Uninstall retains those session records. Deletion from Working Context only removes future model input; prior text remains in runner transcripts and the Event Log. Delete retained data only with your own exact-path approval.

Runner events are inspected before they are appended, rendered or committed. Recognized credential keys/assignments, authorization and cookie headers, private-key markers and selected token prefixes cause the **whole event** (including raw adapter blocks) to be replaced by a fixed omission notice. Numeric values under recognized credential keys are also omitted; ordinary usage counts are retained. Events exceeding inspection limits (1 Mi UTF-16 units, 10,000 visited nodes or depth 32), or containing unsupported metadata objects/accessors, are omitted too; required role/text fields must be own enumerable string data properties and are refused before inspection otherwise; large legitimate outputs can therefore lose recall evidence. Object-key enumeration is not bounded by the visited-node limit. This is a conservative heuristic, not a universal secret detector: unrecognized formats, escaped labels embedded in text and innocuous key names can escape detection. Keep secrets out of prompts and tool output. The policy does not scrub runner transcripts, model-authored Working Context edits, or existing stored history, and performs no retrospective deletion.

If a new session has no committed revision and its Working Context is linked, invalid UTF-8 or over its edit bound, sync refuses and preserves the entry rather than deleting or clearing it. Repair that exact file, or explicitly approve removing that exact entry, before retrying. Existing-revision restore behavior is unchanged. Setup validates every watched runner root for preexisting links/non-directory entries before invoking runner commands; this preflight does not confine concurrent filesystem changes made by an external runner. A ledger-read failure during enable leaves the requested project explicitly off.

Evidence lookups and cold recovery scan the Event Log incrementally. Recall keeps bounded snippets; recovery retains only uncommitted replay candidates. A single very large JSON entry can still consume memory. Citation source reads refuse files above 16 MiB. Optional stale-reference relocation validates line ranges and limits each check to 4,096 candidate windows and 1 MiB of estimated hashing/line work. When enabled, checks also share limits of 64 marker occurrences, 4 MiB of source bytes, 4 MiB of estimated hashing work, eight Git probes of at most 500 ms each, and a four-second cooperative deadline. Sources are cached within the check. Exhaustion reports incomplete and says remaining references were not checked; it does not claim freshness or a nearest moved span. These limits do not delete stored history.

## Troubleshooting and limits

Revision snapshots are limited to 64 MiB of UTF-8 bytes on publication and before reading; runner appends within that ceiling may exceed the model-edit limit. Corrupt or oversized private state fails closed. Event sequences must increase across the complete log; preserve refused state for repair rather than deleting its history. Recovery restores missing accounting for an already committed revision and reports that committed result.

Setup refuses existing runner homes, watched roots and tracked configuration files owned by another user before backing up configuration or invoking runner install commands. Do not bypass an ownership refusal; use your own runner home. Rollback reassesses the captured current configuration and retains late unmanaged edits. If a deletion target changes, setup refuses the deletion and reports any retained candidate for manual recovery.

Setup inventory streams directory entries and refuses more than 4,096 paths, depth beyond 64, or more than 1 MiB of accumulated path names. It never treats a partial inventory as ownership evidence. Configuration containing recognized credential keys is also refused before Context Engine rollback or reverse-edit rewrites it; remove those settings through the runner’s normal configuration process before retrying. Preserve the reported backups on a partial failure.

The managed ignore file and install-pointer deletion are flushed before success. Synthetic fault tests check flush ordering and refusal; they do not prove behavior under real power loss. A relative fallback `HOME` is refused; an explicit absolute state root or absolute `XDG_STATE_HOME` remains valid.

| Symptom | Action |
|---|---|
| Wrong runtime or missing plugin/mod commands | Stop; compare actual CLI help with the baseline. Do not invent a compatibility flag. |
| `/proc` or a confined file read unavailable | Unsupported environment; use a supported host with ordinary permissions. Fail closed. |
| CLI missing, or setup picks wrong runtime | Inspect PATH, use `context-engine-codex` or `node /absolute/checkout/core/cli.ts`; rerun the matching link only when approved. |
| Installed but inactive | Check project scope, `CONTEXT_ENGINE=off`, state-directory consistency, and status reasons. |
| Missing/empty/invalid Working Context or refused reset | Read the visible restore receipt, then reread the latest file. Never force a reset past the gate. |
| Install/uninstall fails | Preserve the output and byte backups; review runner/plugin help and partial changes. Do not overwrite unrelated config. |

Interactive Codex TUI behavior and real interactive hook loading after persistent installation remain **unverified**. The original source had scratch-home install round trips and request-level regressions; a split package does not inherit a new installation success claim. No live model evals are required by normal setup. Tests here use synthetic data and scratch runner homes. Warm, fully applied sessions reuse a validated recovery checkpoint; missing, stale or invalid checkpoints rebuild from the full Event Log. These checks do not establish bounded long-session functional acceptance or interactive delivery.

The plugin relies on the UnderDevelopment `features.token_budget` flag. `status` fails the compatibility claim when guidance is absent; there is no automatic fallback. The separate headless `context-engine-codex-turns` command starts its own app-server and uses a fresh thread each user turn (**Full Replacement per user turn**). It is never started by `install` or `status`; running it is opt-in and consumes model usage. Review its `--help` before use.

## Source, maintenance and checks

See [SOURCE.json](SOURCE.json) for the exact source commit and core hashes, [PROVENANCE.md](PROVENANCE.md) for CLM credit and licenses, [GLOSSARY.md](GLOSSARY.md) for terms, and the [adapter guide](adapters/codex/README.md) for the runtime contract. The original monorepo/history and private captures are preserved separately and are not shipped here. Core updates must use the same reviewed version in both repositories.

`npm test` runs offline tests serially; `npm run typecheck` checks shipped modules. Tests use stand-in runners and scratch homes, not your login/config. Offline setup checks execute runtime-specific delivery status, default-off isolation, record/edit/sync/read lifecycle and README contracts. Explicit sibling-runner cases remain skipped. The real-Codex scratch integration test is separate and skipped by default. Only an authorized supported-host trial may set the test-only CONTEXT_ENGINE_REAL_CODEX_TESTS=1; this requires an existing compatible Codex on PATH and does not establish interactive or model-delivery acceptance. Real plugin loading and request-level acceptance remain separate, explicit checks; do not run costly regression/eval commands as an installation side effect.

Multipart Working Context reads include a content digest in the printed next command. Copy that command exactly, including `--sha`; never construct later-part commands without it. If the file changes between parts, restart at part 1. This prevents combining different file versions. The optional stale-reference `cite` command refuses known credential locations (including project `.env` and `.env.*`, `.npmrc`, `.pypirc`, `.ssh`, `.aws` and `.gnupg`) before reading their bytes. This filename policy cannot identify secrets stored under arbitrary names; do not cite private data.

Codex shell hooks first observe Working Context changes. If an opaque shell command changed or triggered restoration of the file, its command/result is kept in the host conversation rather than appended back into Working Context. Ordinary unchanged shell results still record. The headless turn loop injects validated committed turns, without reopening the mutable file path. Configuration repair retains intervening unmanaged settings and intentional file deletion for later disable.

Install pointers refuse linked paths. Disable/uninstall remove managed files or blocks and retain unowned directories, including empty `.codex` and shared cache parents; configuration bytes and unrelated contents remain preserved.

Setup operations for this runner are serialized by a private setup lock. If setup is interrupted and reports an existing lock, verify that no setup process remains before removing the exact reported lock. A `codex plugin` command that setup started counts as a setup process, because killing setup alone leaves it running. The next install or uninstall then rolls back an install that was interrupted before it finished, keeping unmanaged edits. Until then, enable and status refuse and name the interrupted install record. If a tracked config file no longer parses, a before backup is missing, or the record cannot be verified, setup refuses and names what to repair. Setup also refuses while an interrupted write has left a `.context-engine-setup-`, `.context-engine-replace-` or `.context-engine-delete-` file beside a tracked config file. It names each file and says whether to remove it or move it back. Do not run concurrent install or uninstall commands.

Staged hooks use the absolute Node executable that ran setup. Keep that executable and the checkout path available; reinstall if either moves. If `install --trust-hooks` fails after installation, the install is retained and reported: approve the hooks through `/hooks`, then check `context-engine-codex status`; do not repeat install over its existing record.

The staged Codex hook verifies the nearest private local participation record before importing its checkout. Never-enabled, explicitly disabled and kill-switch sessions remain native even when the checkout is missing. Only a verified enabled record activates the reset gate: a broken checkout then denies `new_context`. Unverifiable or corrupt activation state logs an error where applicable and stands aside; repair state permissions or reinstall before treating Context Engine as active.

See the [release statechart and validation map](docs/context-engine-statechart.md) ([PDF](docs/Context-Engine-Statechart.pdf)) for the published e5da333/644d02b baseline. It does not validate later local fixes.

Participation updates flush the new record before atomic publication, then flush its directory and state root before reporting success. A flush failure is reported; a failure after publication can leave the new state visible and does not imply rollback. Event Log append and torn-tail repair retain the verified parent descriptor through lease creation, stale-lease cleanup, payload writes and lease release, including when that parent is renamed. These synthetic checks do not establish durability under every filesystem or power-loss condition.

If an enabled project was deleted or moved, uninstall validates its recorded pointer and backup ledger, skips writes to the missing location, preserves backups and reports manual cleanup for any relocated project settings. It does not recreate or search for the project. An unsafe pointer or ledger still refuses uninstall and retains metadata for review.

Disabling a subdirectory of an enabled project writes a backed-up local override for inherited Context Engine instructions and token-budget guidance. It preserves the ancestor's activation. Enable replaces that override with active settings; uninstall restores the child's prior config. Conflicting user settings are refused and reported. Activation publication failures attempt to restore project guidance and its ledger and leave participation off; an incomplete rollback is reported with backups retained.

Setup configuration reads are limited to 16 MiB. Setup writes flush the replacement file before rename and its parent afterward; new parents are created through verified descriptors. These checks cover syscall ordering and synthetic failures, not every filesystem's power-loss behavior. If a headless turn finishes but its events cannot be recorded, the loop stops its owned server and refuses another turn; preserve the failure evidence and start a new loop after repairing storage.

Runner event batches must be dense arrays of data events. The core checks the rendered next revision against its UTF-8 byte cap before appending the batch. If an Event Log append may have persisted but its flush failed, close and reopen the session before retrying; recovery reconciles the durable log. Setup rollback refuses a configuration replacement if captured bytes change, preserves the concurrent edit and retains recovery files. Namespace cleanup uses verified directory descriptors and refuses redirected or unsafe entries. Preserve reported backups and repair the cause before retrying.

Codex uninstall retains a private project retirement record so reinstall stays inactive until an explicit enable, while leaving shared participation available to the sibling adapter. A failed prompt recording retains a private fingerprint (no prompt text); later tool recording cannot clear it. Retry that exact original request after repairing storage, or disable Context Engine. Pending intent or an unavailable intent lease blocks resets and compaction. Native compaction omits its marker when appending it would exceed the 16 MiB read-back cap; it still requires a safely readable context. Equivalent TOML key and string spellings are accepted when checking project trust, and uninstall removes Context Engine tables in any equivalent header spelling.

Setup refuses recognized Cookie and Set-Cookie fields before copying configuration into backups. Uninstall verifies runner-home, watched-directory and config-file ownership before runner commands. Rollback uses verified parent descriptors for restore and created-file removal; it preserves redirected paths and concurrent edits. Successful Codex enable removes its temporary publication-only snapshot while retaining project restoration backups; failed cleanup retains and reports its path. Recall, show and read still return evidence when an accounting flush is ambiguous, with accounting reported as skipped.

Completed tool and assistant hooks publish a private fingerprint before syncing or recording. A failed operation retains that fingerprint and blocks later prompts, resets and compaction; later successful hooks cannot clear it. Keep the native conversation and repair storage or disable Context Engine, then recover in a fresh session. Do not replay a completed tool merely to clear intent. If intent publication itself fails, the hook reports refusal, but storage failure can prevent a durable marker; no unconditional recovery guarantee is claimed. If clearing the marker has an ambiguous directory flush, the hook attempts to restore it and reports refusal. The headless turn loop reserves its canonical project, state root and session before starting a server, refuses a second in-process owner and releases the reservation only after confirmed shutdown and session close.

Recovery and recall refuse complete Event Log records containing invalid UTF-8, malformed JSON or invalid runner-event structure. Show refuses malformed records encountered before the requested event. Complete malformed records are preserved for diagnosis, and refusal does not advance HEAD or replace the Working Context. An incomplete final record remains the separate torn-tail recovery case.

Revision recovery verifies the replay boundary before repairing a torn log tail or replacing Working Context. New revisions persist a prepared record binding the revision, digest, parent, replay boundary and kind before publishing HEAD. A missing or mismatched required record is refused. Legacy revisions use available historical accounting. A legacy revision whose accounting was lost cannot supply the same independent boundary proof. Preserve refused state for diagnosis.

Session ownership requires a positive safe-integer process ID before state creation. Handles opened for the same owner share one lock lifetime. Closing either releases that lock and invalidates the other handles, which must be reopened. A new lock generation prevents an old handle from acting after the same process reacquires ownership.

The CLI reads JSON stdin in bounded chunks and refuses input above 64 MiB or invalid UTF-8 before parsing or opening a session. Setup finishes inventory and namespace checks before creating backup copies. A file that disappears during inventory is omitted rather than recorded as an empty file. If snapshot creation fails, setup removes only its own incomplete copies and empty snapshot directories.
