# Context Engine

Model-controlled working-context management for coding agents. The agent edits a document with ordinary tools. Its Adapter determines when and how that revision reaches a later model call.

## Language

### Context

**Working Context**:
The model-maintained document that holds the active task, decisions and source pointers. The agent decides what it holds. It replaces conversation history only at a supported replacement boundary. Additive delivery keeps earlier native history.
_Avoid_: memory, summary, handoff, scratchpad

**Pinned Prefix**:
The part of every model call the agent can't edit: the runner's system prompt, tool definitions and permission instructions. Editable Working Context remains lower-authority data. Replacement frames use user-message authority. Within-turn loading uses ordinary tool output after an explicit read. Static revision notices contain no editable payload.
_Avoid_: protected region, header

**Event Log**:
The append-only record of retained session events. Ordinary inspected runner events are kept verbatim; recognized credential-bearing or uninspectable events are replaced by omission notices before storage. This heuristic does not scrub existing history or runner transcripts. The model never edits the Event Log, and it is not part of the working context.
_Avoid_: transcript (when meaning ours), history, archive

**Offload**:
Moving content out of the working context to somewhere the agent can retrieve it on demand, leaving at most a pointer behind.
_Avoid_: archive (as a verb), forget

**Budget**:
The room, in tokens, an Adapter gives the Working Context in its runner's window (the runner's shared limit minus the Pinned Prefix; Claude also subtracts a reserve for the current turn, measured from earlier turns; Codex halves it to leave room to read the file back). The core reports the Working Context's size against it and reminds the agent as it fills. Not the hard limit, which is only what the runner can physically send.
_Avoid_: cap, quota

**Revision**:
One committed version of a Working Context, identified by its revision number and SHA-256 digest. Ordinary file writes are observed and committed at a synchronization boundary. Preparing a delivery packet or returning a notice does not prove request delivery.
_Avoid_: version, snapshot (a revision snapshot is a stored copy of a revision. Setup's config backups are a Setup Snapshot.)

### Delivery modes

**Full Replacement**:
A delivery mode where conversation input is rebuilt from the Working Context at the supported boundary, so replaced history no longer occupies it. The current human request and runner instructions remain independent inputs.
_Avoid_: live context (unqualified), rewrite

**Injection**:
A delivery mode where the Working Context is added to a conversation that retains its prior history. Both adapters give a static revision and digest notice after an accepted edit. The agent must run the digest-bound CLI read and read every part before a later continuation can receive the file as ordinary tool output. Claude uses the opt-in byte-count frame to preserve file whitespace through its native tool mapper. Neither route promises eviction or a smaller request.
_Avoid_: replacement

**Compaction-only**:
A delivery mode where the working context replaces history only when the runner compacts.
_Avoid_: replacement

### Integration

**Runner**:
The host agent program that makes model calls: Claude Code or Codex.
_Avoid_: harness, client, CLI

**Adapter**:
The runner-specific part that connects the shared core to one runner: the Claude Code mod or the Codex plugin.
_Avoid_: integration, driver

**Turn Loop**:
The Codex Adapter's headless path (`context-engine-codex-turns`): its own app-server client that runs each user turn on a fresh thread holding only the Working Context. Full Replacement per user turn.
_Avoid_: driver

**Participating Session**:
A runner session in which Context Engine is active.
_Avoid_: enabled session

**Baseline**:
The same runner, unmodified, run on the same task, for comparison.
_Avoid_: control, vanilla

### Setup

**Setup Lock**:
The file `<state>/setup/<runner>.setup.lock` that install, uninstall, enable and disable hold for one runner. Setup never treats it as stale. Remove it by hand only after no setup process is running, including a runner plugin command that setup started.
_Avoid_: session lock

**Setup Snapshot**:
A timestamped directory under `<state>/setup/backups/` that holds byte copies of each tracked config file from before a setup change (`before/`) and, once the change finishes, copies from after it (`after/`) and its `ledger.json`. Setup messages call the `before/` copies the before backups. An orphan snapshot belongs to an interrupted install.
_Avoid_: revision snapshot, backup (unqualified)

**Install Record**:
The file `<state>/setup/<runner>.json` that names the Setup Snapshot of a finished install. Uninstall restores runner config from that snapshot. A runner counts as installed only while its Install Record exists.
_Avoid_: install pointer, ledger (in messages for people)

**Interrupted Install Record**:
The file `<state>/setup/<runner>.pending.json`. Install writes it after the before backups and before the first runner command, and removes it when it publishes the Install Record or finishes its rollback. A record left behind means a killed install. The next install or uninstall undoes that install first, and until then enable and status refuse.
_Avoid_: pending record (in messages for people)
