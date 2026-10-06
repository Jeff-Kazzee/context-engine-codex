# Provenance

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

The coordinated 0.1.5 source candidates share all 36 core files and hashes; SOURCE.json pins the common reviewed patch commit and original private snapshot. Source review and owner approval are separate from supported-host installation/release acceptance. Original private histories and benchmark environments remain unchanged.

The previous published candidate contained 30 shared core files at patch `783b50984a37c01ad527d31a099d41737b15c526`. The previous local candidate contained 31 shared core files at patch `13958ee31b2430106319bc08c1b5039becf8bee2`, including a new synthetic regression file. Independent review and owner approval must cover the final candidate before publication. Additional setup and Codex adapter fixes use synthetic fixtures only; no private captures, credentials or original history were imported. Supported-host delivery acceptance remains separate.

Directory-fsync regressions check syscall ordering before HEAD publication. They do not establish power-loss behavior on a real filesystem or supported-host installation acceptance.

Late review candidate pins 32 identical shared core files at patch `fb1de2e451d4ab094bd0dab4dc05cc49ded0fe34`. Six further hosted findings are addressed with synthetic regressions; configuration backup inspection has documented limits. Supported-host installation and next-request acceptance remain separate gates.

Wave7 coordinated candidate pins 33 identical shared core files at patch `5bbeba8ee93191572a7280624f4c6260214f3fb1`. Five newly confirmed findings are repaired with synthetic regressions. Prior ambient installation pointers were left untouched; fresh source review and supported-host acceptance remain separate gates.

Final Wave7 source pin is `30f6cf32a7b0a650bcc33e9da7e9afe4ee60a2bb` (33 matching core files), including the minimal supporting lock-turnover correction exposed by validation. Unsafe descriptor payloads remain unread and persistent refusal cannot trigger dead-holder takeover.

The local Wave8 candidate adds independently authored synthetic controls for no-HEAD rejection preservation, watched-root preflight, fail-closed enable and conservative runner-event credential omission. It imports no credential payloads or private captures. Inspection is heuristic and bounded by visited data; historical retention and supported-host acceptance remain separate.

Wave8 local reviewed source pin: `ced4d442d5166a69ab815efbd719fc19f746cc39` (35 identical core files in both distributions). The four-finding patch does not resolve separately inventoried participation durability, removed-project uninstall or Event Log creation lease findings; supported-host trial remains held.
