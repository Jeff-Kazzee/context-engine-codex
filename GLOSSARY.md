# Context Engine

Model-controlled working-context management for coding agents: the agent edits its own context, and that edited context is what its next model call sees.

## Language

### Context

**Working Context**:
The model-maintained document that stands in for conversation history on the next model call. The agent alone decides what it holds.
_Avoid_: memory, summary, handoff, scratchpad

**Pinned Prefix**:
The part of every model call the agent can't edit: the runner's system prompt, tool definitions and permission instructions. The Working Context always sits after it, at user-message authority.
_Avoid_: protected region, header

**Event Log**:
The append-only, verbatim record of everything that happened in a session. The model never edits it, and it is not part of the working context.
_Avoid_: transcript (when meaning ours), history, archive

**Offload**:
Moving content out of the working context to somewhere the agent can retrieve it on demand, leaving at most a pointer behind.
_Avoid_: archive (as a verb), forget

**Budget**:
The room, in tokens, an Adapter gives the Working Context in its runner's window (the runner's shared limit minus the Pinned Prefix; Claude also subtracts a reserve for the current turn, measured from earlier turns; Codex halves it to leave room to read the file back). The core reports the Working Context's size against it and reminds the agent as it fills. Not the hard limit, which is only what the runner can physically send.
_Avoid_: cap, quota

**Revision**:
One committed version of a working context. Every write names the revision it was based on.
_Avoid_: version, snapshot (a snapshot is a stored copy of a revision)

### Delivery modes

**Full Replacement**:
A delivery mode where the next model call's conversation input is rebuilt from the working context, so deleted or replaced content no longer occupies it.
_Avoid_: live context (unqualified), rewrite

**Injection**:
A delivery mode where the working context is added to a conversation that keeps growing underneath it.
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
