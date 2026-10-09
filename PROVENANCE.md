# Provenance

The Wave10 coordinated repair pins `a30ff15e25aabc23f1625dd9eb791c0b2117855e` from the Claude distribution, with 37 identical shared core files in both runtime repositories. New controls use synthetic filesystem failures and runner doubles. They import no private captures or credentials and do not extend the prior live-trial acceptance to these revised heads. Source review, publication, owner merge approval and runtime acceptance remain separate gates.

The independently implemented Context Engine core is MIT-licensed (see `LICENSE`). This file lists every external
source the code draws on, with its license and what was used.

## Credit: Context Language Models

Context Engine adapts the mechanism described in *Context Language Models* by Rulin Shao,
Shannon Zejiang Shen, Junjie Oscar Yin, Yuetai Li, Minheng Wang, Hamish Ivison, Radha Poovendran,
Nathan Lambert, Teng Xiao, Mike Lewis, Wen-tau Yih, Luke Zettlemoyer and Pang Wei Koh.

```bibtex
@article{shao2026context,
  title   = {Context Language Models},
  author  = {Shao, Rulin and Shen, Shannon Zejiang and Yin, Junjie Oscar and Li, Yuetai and
             Wang, Minheng and Ivison, Hamish and Poovendran, Radha and Lambert, Nathan and
             Xiao, Teng and Lewis, Mike and Yih, Wen-tau and Zettlemoyer, Luke and Koh, Pang Wei},
  journal = {arXiv preprint arXiv:2609.37725},
  year    = {2026}
}
```

## Sources

| Source | Version | License | What was used |
|---|---|---|---|
| Paper: [arXiv:2609.37725](https://arxiv.org/abs/2609.37725) | v1, 29 Sep 2026 | CC BY 4.0 | Concepts, re-derived and cited: the live context mirrored to a file the model edits with its ordinary tools (Sec. 4.1); turn blocks headed `[[CTX_TURN <n> role=<role>]]` (Sec. 4.1, Fig. 3); model edits synchronized into the next call (Sec. 4.1); a per-turn size readout, because models estimate their own context length poorly (App. G); the eval task families and grading from context only (App. D). |
| Upstream code, turn parsing: [facebookresearch/context-language-models](https://github.com/facebookresearch/context-language-models) (`clm/clm_harness/context_utils/context_string.py`, `parse_back`) | commit `18dc11115f50f261233c5bba7937834491e307e8` | CC BY-NC 4.0 | **Nothing copied.** No code, regular expression, prompt text or data. Its observable parse behaviour (stray text becomes a user turn, non-assistant roles fold to user, turn numbers ignored, empty turns dropped, same-role turns merged) was summarized in prose in our research notes (`docs/research/clm-paper-and-upstream.md`, branch `research/clm-paper-and-upstream`), and `core/turns.ts` was written independently from that description. |
| Upstream code, budget nudges: [`clm/clm_harness/utils/budget.py`](https://github.com/facebookresearch/context-language-models/blob/18dc11115f50f261233c5bba7937834491e307e8/clm/clm_harness/utils/budget.py) (`nudge_message`, `adaptive_persistent_trigger`) | commit `18dc11115f50f261233c5bba7937834491e307e8` | CC BY-NC 4.0 | **Behaviour and ideas only; no code or text copied.** The reminder schedule in `core/budget.ts` was re-implemented in our own code and wording from the upstream harness's behaviour as described in our research note (`docs/research/clm-paper-and-upstream.md` §3, branch `research/clm-paper-and-upstream`): reminders at 25/50/75% of the budget, the 25% one informational only, and an urgent reminder on every check once headroom is under max(10% of the budget, 2 × the largest of the last three growths), capped at half the budget. The paper itself describes only a single editing reminder before the budget (research note §4.3), so these are not the paper's. None of upstream's nudge strings or its note contract is used. |
| Upstream code, edit receipts: [`clm/clm_harness/context_env/env.py`](https://github.com/facebookresearch/context-language-models/blob/18dc11115f50f261233c5bba7937834491e307e8/clm/clm_harness/context_env/env.py) (`_apply_edit`) | commit `18dc11115f50f261233c5bba7937834491e307e8` | CC BY-NC 4.0 | **Idea only; no code or text copied.** A short receipt after an edit is applied (research note §2.3). Our receipts' content and wording (revision, sizes, restore reason) are our own. |

## Re-derived in this repository

- `core/turns.ts`: the turn-block renderer and tolerant parser. Written from scratch. It adds
  rules of our own (header lookalike lines in a turn body are escaped with a backslash; headers
  accept optional numbers and loose spacing/case).
- `core/budget.ts`: the reminder schedule (upstream behaviour, see the table) in our own code and
  wording; the texts and the Event Log accounting are ours.
- Validation and restore (`core/session.ts`) and the Codex reset gate (`adapters/codex/`): our own
  design (#7, #22). They are not upstream's fit/shrink edit gate (`context_env/edit_gate.py`), which
  we did not reimplement.
- `core/session.ts`, `core/store.ts`, `core/lock.ts`: the storage and write protocol (HEAD
  commit point, numbered revisions, write-ahead Event Log, recovery, single-writer lock). Our own
  design, from issue #7 and the `prototype/core-state` prototype; not from the paper or upstream.

## Development-only dependencies (not shipped at runtime)

| Package | Version | License | Use |
|---|---|---|---|
| `typescript` | 7.0.2 | Apache-2.0 | `tsc --noEmit` type checking |
| `@types/node` | 24.19.1 | MIT | Node type definitions for type checking |

The core has no runtime dependencies; Node 24 runs the TypeScript sources directly.

## Distribution snapshot and runtime compatibility

`SOURCE.json` pins the original source commit and the SHA-256 of every shared core file. Both runner repositories vendor that same core version; setup is specialized for one runner. Update the two manifests together from one reviewed source commit, never by silently editing one vendored core. Original Git history, research notes, prototypes, captured requests and eval/regression evidence are not imported. This distribution makes no new model-performance claims.

| Source | Version | License | Use |
|---|---|---|---|
| [OpenAI Codex](https://github.com/openai/codex/tree/a956835d020762cb2b570053af06f643a11c0ecc) | rust-v0.160.0, commit `a956835d020762cb2b570053af06f643a11c0ecc` | [Apache-2.0](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/LICENSE) | Runtime protocol behavior and numeric tool-output limits inform `core/recall.ts`; Codex distribution also implements config/hook/app-server compatibility. No Codex source code or captured prompt text is included. |

Upstream CLM code is CC BY-NC 4.0. No upstream CLM code or prompt quotations are shipped in these snapshots; original research history remains private and was not imported. The implementation claims above concern the core mechanism, not a legal certification of all runner interfaces.

The earlier Wave20 coordinated 0.1.5 source candidates shared 41 core files and hashes. SOURCE.json pins the common reviewed patch commit and original private snapshot. Source review and owner approval are separate from supported-host installation/release acceptance. Original private histories and benchmark environments remain unchanged.

The previous published candidate contained 30 shared core files at patch `783b50984a37c01ad527d31a099d41737b15c526`. The previous local candidate contained 31 shared core files at patch `13958ee31b2430106319bc08c1b5039becf8bee2`, including a new synthetic regression file. Independent review and owner approval must cover the final candidate before publication. Additional setup and Codex adapter fixes use synthetic fixtures only; no private captures, credentials or original history were imported. Supported-host delivery acceptance remains separate.

Directory-fsync regressions check syscall ordering before HEAD publication. They do not establish power-loss behavior on a real filesystem or supported-host installation acceptance.

Late review candidate pins 32 identical shared core files at patch `fb1de2e451d4ab094bd0dab4dc05cc49ded0fe34`. Six further hosted findings are addressed with synthetic regressions; configuration backup inspection has documented limits. Supported-host installation and next-request acceptance remain separate gates.

Wave7 coordinated candidate pins 33 identical shared core files at patch `5bbeba8ee93191572a7280624f4c6260214f3fb1`. Five newly confirmed findings are repaired with synthetic regressions. Prior ambient installation pointers were left untouched; fresh source review and supported-host acceptance remain separate gates.

Final Wave7 source pin is `30f6cf32a7b0a650bcc33e9da7e9afe4ee60a2bb` (33 matching core files), including the minimal supporting lock-turnover correction exposed by validation. Unsafe descriptor payloads remain unread and persistent refusal cannot trigger dead-holder takeover.

The local Wave8 candidate adds independently authored synthetic controls for no-HEAD rejection preservation, watched-root preflight, fail-closed enable and conservative runner-event credential omission. It imports no credential payloads or private captures. Inspection is heuristic and bounded by visited data; historical retention and supported-host acceptance remain separate.

Wave8 local reviewed source pin: `ced4d442d5166a69ab815efbd719fc19f746cc39` (35 identical core files in both distributions). The four-finding patch does not resolve separately inventoried participation durability, removed-project uninstall or Event Log creation lease findings; supported-host trial remains held.
Wave9 local reviewed source pin: 54b51f56b98980eac5b2dce5a40397bf1436737e (36 identical core files). The three separately inventoried findings are repaired with synthetic controls, including post-publication flush failures, recursive stale leases and malformed missing-project ledgers. Supported-host trial remains held; publication and installation acceptance are separate gates.

Wave11 coordinated source candidate pins `33ad316291f34f20e7cf0148dd7397c474892854` (38 identical core files). Nine hosted claims were reproduced and repaired with synthetic regressions; the supported Linux HOME control passed on the unchanged source, so it is not classified as a defect. Older project-repair ledgers referencing sibling snapshots fail closed; preserve backups and use the original checkout to uninstall before updating. No model/runtime acceptance or real power-loss proof is inferred.

Wave13 coordinated source pin: `bd9c96a1a8ba2fcaf7be6f9762e0d64d2f7aed8d` (39 identical core files). Eleven current-head review claims were reproduced and repaired. The allocation, durability, recovery, setup and delayed-callback gaps predate Wave11; relative-HOME handling lacked an absolute-root check before and after explicit environment support. Fault fixtures establish bounded refusal, flush ordering and retry behavior, not real power-loss proof. LIVE12 Claude narrow PASS remains evidence for its earlier exact head; Codex LIVE12 failed because its scratch runtime lacked the separate code-mode host. No new live/model trial, authentication changes, scanner clearance or merge approval is inferred.

Wave16 coordinated source pin: `9f1ae5ff06e6ec311ad535a2b710aec23fed422b` (40 identical core files). Wave16 finite review repair: integer hard limits; malformed opt-in responses use native fallback; setup verifies runner/config ownership before payload backups, reassesses captured rollback bytes and reserves deletion candidates through a verified parent. Codex explicit hook trust fails on incomplete verification and status accepts equivalent TOML table-key spelling. Optional, default-off stale-refs checks share marker, source-byte, hash-work, Git-probe and time budgets when enabled; exhaustion reports incomplete. Synthetic offline evidence only; no model/provider trial, authentication changes, scanner clearance or merge approval.

Wave20 coordinated source pin: `b8cc06331409cca06aec7b0c6e9d472f73e59880` (41 identical core files). Wave20 repairs nine confirmed review claims: pre-log dense event and rendered byte validation; Event Log parent flush and ambiguous-append recovery; conditional config replacement and confined namespace cleanup; semantic Codex TOML trust, uninstall retirement, durable failed-prompt intent and bounded compaction markers. Synthetic offline checks only; current-head supported-runtime acceptance remains unverified. Fault fixtures establish refusal, syscall ordering and recovery behavior, not real power-loss proof. No private captures, credential payloads or original Git history were imported; source review does not approve installation or merge.

Wave26 coordinated source pin: `0e9a424617389034cbd6a32d5630754fdf79ef21` (41 identical core files). Wave26 repairs nine confirmed review claims: recognized Cookie/Set-Cookie backup refusal; confined rollback restore and created-file deletion; pre-command uninstall ownership; temporary publication snapshot cleanup; ambiguous recall-accounting evidence preservation; conditional project-config publication; durable completed-event fingerprints and exclusive in-process turn-loop ownership. Synthetic offline checks only; current-head supported-runtime acceptance remains unverified. Fault fixtures establish refusal, syscall ordering and recovery behavior, not real power-loss proof. No private captures, credential payloads or original Git history were imported; source review does not approve installation or merge.

Wave29 coordinated source pin: `6fffaad613524cfd9c62cc733a7915583c2a7e7d` (42 identical core files). The nine review fixes preserve empty project files and remove managed EOF guidance, distinguish committed prompt retries, retain ambiguous recovery notices, recover a dead publisher's verified extra lock name, flush setup lock removal, anchor empty-directory cleanup, and retire Claude handles before unmanaged fallback or after failed frame-key validation. Recovery controls distinguish the publisher from the session owner and preserve live-owner refusal. CLI confirmation records a complete output-transport write; it does not establish model receipt. All regressions use synthetic data and scratch runner doubles. They establish ordering, refusal, and recovery behavior, not actual power-loss or supported-runtime acceptance. No credentials, private captures, original history, billing changes, or model calls are part of this repair. Source push, exact-head merge approval, and live acceptance remain separate gates.

Wave31 coordinated source pin: `e072817b45d072fff72df3c81a80562b64f0145d` (43 identical core files). The Event Log stores each optional record operation ID with its numbered events and retained-event digest. Exact retries reuse that row, including after interrupted publication. Reusing an ID with different retained events fails. Codex persists the ID before calling the CLI, and a new prompt receives a new ID even when its text matches. Older ambiguous pending markers without an ID are refused. Session close attempts lock release even when recovery-notice confirmation fails, preserving the confirmation error. The turn loop releases its local ownership only after confirmed app-server shutdown. Synthetic regression controls include an actual hook-process kill after successful recording. No provider call, supported-runtime acceptance, or power-loss guarantee is implied.

Wave44 shared-core source pin: `b7077d7879babcf901069eabad41363623ddd4ba` (47 identical core files). the shared host contract represents opened-directory targets and semantic access facts. The Linux backend retains confinement, lock publication and filesystem ordering. Each metadata inspection uses one existing stat operation. Private access and creation modes stay in the backend, and unknown required ownership is refused. An explicit-dot directory target preserves the final component so cleanup inspects the opened directory instead of its descriptor link. Native Windows tests cover pure public operations and refusal before state or setup mutation. Windows and macOS stateful backends are not implemented. Offline checks do not establish provider request replacement, ordinary-profile installation or power-loss durability.

### Within-turn Working Context loading

The shared packet builder validates a committed revision, exact UTF-8 digest, byte ceiling and context budget. It never truncates a packet. Both distributions use the same shared core. Preparing a packet is separate from submitting it or observing it in a native request.

Claude Code 2.1.289 serializes tool-hook context as a system message. The default adapter therefore emits only static revision metadata and a digest-bound read instruction there. Native plugin setup supplies the retained core CLI path through the public `coreCli` user configuration option. Source-layout loading uses the explicit `checkout-relative` default.

Claude's ordinary CLI command opts into the shared `read --framed` format. The versioned header declares the payload byte length, part identity, total file bytes and SHA-256 digest. The reader consumes the declared UTF-8 bytes before checking the fixed footer. A footer lookalike inside the payload cannot end it early. Framing keeps file whitespace inside the output boundaries. Every part includes framing metadata and fits the same 32,000-byte output bound. Default plaintext reads remain compatible.

Codex also emits only static revision metadata through its higher-authority hook context. The editable payload reaches a later continuation after the agent completes the ordinary digest-bound read. Both paths retain earlier native history. Neither implements the paper's automatic per-step context eviction or guarantees a smaller request.

Claude's existing compaction guard remains in place. When its native tail contains Bash and the Working Context revision changed since the previous replacement, the adapter stands aside before recording. A successful within-turn CLI read does not count as a replacement and does not clear that guard. Later automatic replacement requires separate acceptance.

The implementation and synthetic fixtures are independently authored. Public runner interface declarations and CLI help informed adapter compatibility. The source distributions contain no runner implementation code, captured native prompt or tool-schema prose, upstream CLM code, credentials or private session content. Earlier provenance entries retain their original snapshot and acceptance limits.


On 2026-10-08 UTC, native request observations passed against the frozen Wave48G source with Claude Code 2.1.289 and Codex 0.161.0. Each fixture kept one human turn, the current request and the native instructions and tool definitions. Static notices contained no editable payload. The digest-bound reads reached later requests as ordinary tool results, with earlier native history retained.

Claude's fixture reconstructed all 341 UTF-8 bytes from the framed result. Its payload included Unicode, a permitted C1 control sequence, carriage returns, trailing whitespace and a footer lookalike. This is evidence for that exact fixture, not arbitrary control sequences or binary data. Codex's native workspace sandbox allowed the intended project work and refused an attempted write to a separate private fixture file. The file's digest stayed unchanged.

Request-assembly observations use fixed synthetic local protocol responses in disposable profiles. They do not measure model reasoning, autonomous compliance with read instructions, external provider delivery or long-session performance. The Codex direct-host fixture retains the native workspace sandbox and disables tool networking. Its parent runtime process has no global egress constraint, and incidental runtime network traffic is not measured.

Wave48 shared-core source pin: `045582297117f5084f4a24136c7dae6ea2590261` (49 identical core files in both distributions). This local pin includes the bounded packet and framed-read implementation described above. The original snapshot commit remains unchanged.

Wave51 shared-core source pin: `06bb6cf91cb7bb7716d6da0364b16d0dd3fbfc1e` (50 identical core files in both distributions). This pin includes complete Event Log corruption refusal and Unicode cut preservation. The original snapshot commit remains unchanged.

Wave52 shared-core source pin: `2e0633e44257c1b024920e12246ad14dfa0c1ca5` (53 identical core files in both distributions). This pin binds new revision replay boundaries to prepared records, preserves legacy recovery limits, validates owner process IDs before mutation, identifies each lock lifetime, and bounds CLI JSON stdin. Coordinated setup and adapter fixes cover interrupted snapshots, bounded Claude budget observations, Codex managed paths and settings at EOF, and completed-tool retry identity. Synthetic fault controls and compatibility tests do not establish ordinary-profile installation, interactive delivery, bounded long-session acceptance or power-loss durability. No private captures, credentials or original private Git history were imported. The original snapshot commit remains unchanged.

The Codex completion contract was checked against the public `rust-v0.161.0` source: [PostToolUse event fields](https://github.com/openai/codex/blob/rust-v0.161.0/codex-rs/hooks/src/events/post_tool_use.rs), [Stop input schema](https://github.com/openai/codex/blob/rust-v0.161.0/codex-rs/hooks/schema/generated/stop.command.input.schema.json), [hook runtime](https://github.com/openai/codex/blob/rust-v0.161.0/codex-rs/core/src/hook_runtime.rs), and [turn continuation](https://github.com/openai/codex/blob/rust-v0.161.0/codex-rs/core/src/session/turn.rs). Tool completion exposes `tool_use_id`. Multiple Stops can share one turn ID, so ambiguous Stop retry remains a documented refusal boundary. These sources informed independently authored code and tests. No upstream implementation was vendored.

U01 shared-core source pin: `49c06882c77d186dc6cf5bb4a30a51b7ac0ae7e8` (58 identical core files in both distributions) adds real-process kill, concurrency and syscall-order tests, keeps a model edit that races a runner append in the Event Log with a restore receipt unless an editor renames its own file over the Working Context in the instant before the core's rename, repairs an empty managed ignore file left by a killed first open, makes concurrent first opens wait for the managed ignore file and for another opener's frame-key publication, and removes test-made temporary directories when each test process exits or receives SIGTERM.
