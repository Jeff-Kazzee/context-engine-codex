# Full Replacement through supported runner seams only: no proxy, no fork

Faithful CLM needs each runner's next request rebuilt from the Working Context. The obvious way to get that on every model step is a local request-rewriting proxy, or a patched runner. We ruled both out.

- The proxy would carry the user's Claude OAuth or ChatGPT bearer in flight, and it makes the runner's own transcript disagree with what was sent.
- A fork means maintaining a custom binary.

Each Adapter uses supported or early-access seams instead:

- **Claude Code:** a mod answers `session.compact`. That is Full Replacement per user turn and Injection within a turn. A per-step `turn.step` variant is opt-in.
- **Codex:** `features.token_budget`'s `new_context` gives Full Replacement at agent-initiated resets (any model step); history grows between resets. The turn loop, an own app-server client using `thread/start` + `thread/inject_items` (a fresh thread each user turn), is the stable per-turn path. `thread/revert` back to the first turn works only once on 0.160.0, so it can't be used (#14).

Decided with Jeff on 2026-10-05 (issue #8), with evidence on the `prototype/claude-seam` and `prototype/codex-seam` branches.

## Consequences

- Claude Code's default mode is *not* per-step. Long single-turn work grows within the turn, and every report must say so.
- The Codex reset path depends on an UnderDevelopment flag. If it changes, `context-engine status` reports that path as inactive, with the reason, and points to the per-turn turn loop. Nothing switches over automatically, and no report may claim the reset mode for a project where status shows it inactive.
