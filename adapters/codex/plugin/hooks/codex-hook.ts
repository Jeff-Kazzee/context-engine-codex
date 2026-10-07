#!/usr/bin/env node
// Context Engine Codex Adapter: one command hook for every Codex hook event.
//
// Codex runs `node "$PLUGIN_ROOT/hooks/codex-hook.ts"` through `$SHELL -lc` with the event JSON on
// stdin (codex-cli 0.160.0). The plugin is copied into Codex's plugin cache at install time, so the
// shared core is found through the checkout's CLI path that setup bakes into the hook command
// (CONTEXT_ENGINE_CLI=<checkout>/core/cli.ts): the core library sits beside it. Run from the
// checkout itself (tests, the regression), the core is found relative to this file. Session work
// goes through the `context-engine` CLI, which also serializes concurrent hooks of one session.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { locallyEnabled } from './activation.ts';
import type * as Core from '../../../../core/index.ts';
import type * as Guidance from '../../guidance.ts';
import type * as Store from '../../../../core/store.ts';
import type * as Lock from '../../../../core/lock.ts';

interface HookInput {
  hook_event_name: string;
  session_id: string;
  cwd: string;
  [field: string]: unknown;
}

const RUNNER = 'codex';
/**
 * Hard limit for the Working Context, in characters: what Codex can physically send. The models in
 * codex-cli 0.160.0's catalog have a 272,000-token window; minus ~32,000 tokens for the Pinned
 * Prefix and the turn, at the core's ~4 chars per token. Override with CONTEXT_ENGINE_HARD_LIMIT.
 */
const DEFAULT_HARD_LIMIT = (272_000 - 32_000) * 4;

/** The core could not be reached or refused the call. The event's handler selects its refusal/fallback. */
class CoreUnavailable extends Error {}
/** Context Engine is not active for this project (not enabled, or the kill switch): stand aside silently. */
class Inactive extends Error {}
class PendingPrompt extends Error {}

/**
 * A checkout module: beside the CLI the hook calls (`<checkout>/core/cli.ts`), or relative to this
 * file when it runs from the checkout itself.
 */
async function loadFromCheckout<T>(fromCheckout: string, fromHere: string): Promise<T> {
  const cli = process.env.CONTEXT_ENGINE_CLI;
  const url = cli && /\/core\/cli\.ts$/.test(cli) ? pathToFileURL(join(dirname(cli), '..', fromCheckout)) : new URL(fromHere, import.meta.url);
  return (await import(url.href)) as T;
}

let lib: typeof Core;
/** The Working Context's budget in tokens (adapters/codex/guidance.ts codexWorkingContextBudget). */
let budgetTokens: number;
let confirmedParticipation = false;
let store: typeof Store;
let lock: typeof Lock;
const PENDING_PROMPT = 'codex-prompt-pending.json';
function withPromptLease<T>(input: HookInput, fn:()=>T): T {
  const state=store.resolveStateRoot(),l=store.layout(input.cwd,input.session_id,state);
  store.ensureDirs(l,state);
  // Distinct from the CLI operation lease: never recursively acquire that lock.
  return lock.serialized(join(l.stateDir,'codex-prompt.lock'),fn,{timeoutMs:1000});
}
function pendingPrompt(input: HookInput): { path: string; hash?: string } {
  try {
    const l=store.layout(input.cwd,input.session_id,store.resolveStateRoot());
    const path=join(l.stateDir,PENDING_PROMPT),bytes=store.readBytes(path,1024);
    if(!bytes)return {path};
    const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
    if(typeof value.hash!=='string'||!/^[0-9a-f]{64}$/.test(value.hash))throw new Error('invalid pending prompt marker');
    return {path,hash:value.hash};
  } catch {throw new PendingPrompt('Context Engine: a pending prompt could not be verified. Do not reset; retry the original request after repairing storage, or disable Context Engine.');}
}

/** The agent's own reset (new_context): the one event that fails closed. */
const isResetGate = (input: HookInput): boolean => input.hook_event_name === 'PreToolUse' && input.tool_name === 'new_context';

const NOT_RESET = 'Context Engine: the context window was NOT reset, so nothing was lost.';

function denyReset(refusal: string): void {
  emit({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `${refusal} Then call new_context again` } });
}

/**
 * The event is read before any checkout module is loaded, so a failure to load them (the checkout
 * moved or deleted, a module that throws) is seen with the event in hand: the reset gate then
 * refuses only after cache-local opt-in was verified (see the handler at the bottom). Prompt and
 * compaction failures also stop the request; ordinary tool hooks stand aside.
 */
async function main(input: HookInput): Promise<void> {
  // Subagents (multi-agent mode) get no Working Context; only the root agent's session is managed.
  if (input.agent_id) return;
  confirmedParticipation = locallyEnabled(input.cwd);
  if (!confirmedParticipation) return;
  lib = await loadFromCheckout<typeof Core>('core/index.ts', '../../../../core/index.ts');
  store = await loadFromCheckout<typeof Store>('core/store.ts', '../../../../core/store.ts');
  lock = await loadFromCheckout<typeof Lock>('core/lock.ts', '../../../../core/lock.ts');
  const guidance = await loadFromCheckout<typeof Guidance>('adapters/codex/guidance.ts', '../../guidance.ts');
  budgetTokens = guidance.codexWorkingContextBudget(process.env.CONTEXT_ENGINE_BUDGET_TOKENS);
  // Cache-local opt-in was checked before imports; the core repeats the participation gate.
  if (lib.killSwitchOn()) return;
  if (input.hook_event_name === 'UserPromptSubmit') {
    const result=withPromptLease(input,()=>{
    const hash=store.sha(String(input.prompt??'')),pending=pendingPrompt(input);
    if(pending.hash&&pending.hash!==hash)throw new PendingPrompt('Context Engine: an earlier user request was not recorded. Retry that exact request after repairing storage, or disable Context Engine; resets remain blocked.');
    // Durable intent precedes the fallible CLI call. Only a fingerprint is retained, never prompt text.
    store.atomicWrite(pending.path,JSON.stringify({hash}), 'frame-key-tmp');
    const recorded = core(input, 'record', [{ role: 'user', text: String(input.prompt ?? '') }]);
    store.removeDirectoryEntries(dirname(pending.path),name=>name===PENDING_PROMPT);
    return recorded;
    });
    // The per-turn size readout, with any reminder this prompt fired (an episode may make no tool
    // call for many turns). Codex hands additionalContext to the model as a developer message, so
    // only the core's static budget text goes there: numbers and fixed wording, never the prompt or
    // any Working Context text.
    const notices = [...(result.receipt?.kind === 'restored' ? [result.receipt.text] : []), ...(result.budget ? [result.budget.text] : [])];
    if (notices.length) emit({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: notices.join('\n') } });
  } else if (input.hook_event_name === 'PostToolUse') {
    // A call that reads or edits the Working Context (or offloaded files beside it) is only synced:
    // echoing it back would duplicate the file into itself, or re-add what the agent offloaded.
    let ownFile = touchesWorkingContext(input);
    const shell = typeof (input.tool_input as Record<string, unknown> | undefined)?.command === 'string';
    const observed = ownFile || shell ? core(input, 'sync') : undefined;
    // Actual file effects, not arbitrary command syntax, decide whether shell text could resurrect edits.
    if (shell && (observed?.receipt?.kind === 'committed' || observed?.receipt?.kind === 'restored')) ownFile = true;
    const result = ownFile ? observed! : core(input, 'record', [{ role: 'tool', text: renderToolCall(input) }]);
    // A restore (always) and stale citations (stale-refs experiment, Working Context calls only) go
    // out as `block`, which replaces the tool result the model sees, the original output kept below
    // the notice: the agent must see them before it touches the file again. A budget reminder (a tier
    // once, urgent on every call, with the readout) goes beside the output as additionalContext and
    // leaves the result alone: in code mode a blocked result reads as a script error, which broke
    // read-back in smoke 2. A plain commit needs no notice. All of it is static text with numbers.
    const out: Record<string, unknown> = {};
    const receipt = result.receipt;
    const restored = receipt?.kind === 'restored';
    if (receipt && (restored || (ownFile && receipt.stale))) {
      Object.assign(out, { decision: 'block', reason: `${receipt.text}${restored ? ' Re-read the file before editing it again.' : ''}\n\nTool output:\n${responseText(input)}` });
    }
    const budget = result.budget;
    if (budget && (budget.tier || budget.urgent)) out.hookSpecificOutput = { hookEventName: 'PostToolUse', additionalContext: budget.text };
    if (Object.keys(out).length) emit(out);
  } else if (input.hook_event_name === 'PreToolUse' && input.tool_name === 'new_context') {
    // The reset gate: a refusal here reaches the model as the new_context tool result, so it can
    // fix the file and retry. The reset itself only happens after this step's sampling ends.
    const refusal = withPromptLease(input,()=>{
      if(pendingPrompt(input).hash)throw new PendingPrompt('Context Engine: the context window was NOT reset. An earlier user request was not recorded; retry that exact request after repairing storage, or disable Context Engine.');
      return resetRefusal(input);
    });
    if (refusal) denyReset(refusal);
  } else if (input.hook_event_name === 'Stop') {
    if (typeof input.last_assistant_message === 'string' && input.last_assistant_message.trim()) {
      core(input, 'record', [{ role: 'assistant', text: input.last_assistant_message }]);
    }
  } else if (input.hook_event_name === 'PreCompact') {
    withPromptLease(input,()=>{
    if(pendingPrompt(input).hash)throw new PendingPrompt('Context Engine: compaction was stopped because an earlier user request was not recorded. Retry that exact request after repairing storage, or disable Context Engine.');
    // Backstop for resets the gate above never sees (the token limit, a manual /compact). Codex
    // only honours `continue:false`; it aborts the turn, and the user sees the stop reason. So it
    // stops a reset onto an unusable or unreadable file and does no token-budget
    // check: this reset is Codex's own, made because the window is already full, so refusing it for
    // size would abort the user's turn and free nothing; and `context-engine read` pages a file of
    // up to 16 MiB; larger payloads must be offloaded (budget reminders warn earlier).
    const refusal = resetRefusal(input, { budget: false });
    if (refusal) emit({ continue: false, stopReason: refusal });
    // Mark the reset in the file, as a new_context call is marked, unless that marker is already the
    // last turn (a new_context reset reaches PreCompact too, also as `auto`). This reset is the
    // runner's, not the agent's: the marker and its Event Log entry carry the Compaction-only label.
    else if (!lastTurnIsReset) {
      const manual = input.trigger === 'manual';
      const delivery = manual ? lib.CODEX_MANUAL_COMPACTION.label : lib.CODEX_TOKEN_LIMIT_RESET.label;
      try {core(input, 'record', [{ role: 'tool', text: backstopMarker(delivery, manual), delivery }],lib.READ_MAX_FILE_BYTES);}
      catch(e) {
        // A marker may be omitted; a reset onto an unreadable context may not proceed.
        const after=resetRefusal(input,{budget:false});
        if(after)emit({continue:false,stopReason:after});
        else if(!(e instanceof CoreUnavailable))throw e;
      }
    }
    });
  }
}

/** Syncs the Working Context before a reset. Returns why the reset must not happen, or null. */
function resetRefusal(input: HookInput, check: { budget: boolean } = { budget: true }): string | null {
  const notReset = NOT_RESET;
  let result: CoreResult;
  try {
    result = core(input, 'sync');
  } catch (e) {
    if (e instanceof Inactive) throw e;
    log(e);
    const path = lib.workingContextRelPath(input.session_id);
    // The agent's own reset (new_context) fails closed: without the core nothing can show the file
    // is usable (valid UTF-8, under the hard limit and the budget), and refusing costs only a retry.
    if (check.budget) {
      return `${notReset} The Context Engine core could not be reached, so your Working Context ${path} could not be checked, and resetting onto a file that cannot be delivered would lose the conversation. Carry on in this window for now.`;
    }
    // Codex's own reset (PreCompact) happens because the window is full; stopping it aborts the
    // user's turn. Without the core, require a safely readable file within the multipart byte bound.
    let text = '';
    try {
      const bytes = lib.readWorkingContextFile(join(input.cwd, path), lib.READ_MAX_FILE_BYTES);
      if (bytes === 'too-large') return `${notReset} Your Working Context exceeds the 16 MiB read limit. Offload large content with source pointers before resetting.`;
      if (Buffer.isBuffer(bytes)) text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {}
    return lib.parseTurns(text).some(turn => turn.text.trim() !== '') ? null : `${notReset} Your Working Context ${path} is missing or empty. Write the current task, decisions and next step into it.`;
  }
  // The marker is a tool turn, which folds to user and merges into a user turn before it (separated
  // by a blank line), so look at the last paragraph of the last turn, not at its start. (Checking the
  // start missed every new_context reset in the pilot, which got a second, token-limit marker.)
  const lastTurn = String(result.turns?.at(-1)?.text ?? '');
  lastTurnIsReset = (lastTurn.split(/\n[ \t]*\n/).at(-1) ?? '').trimStart().startsWith('Context window reset');
  const path = relative(input.cwd, result.workingContext ?? '') || lib.workingContextRelPath(input.session_id);
  if (result.receipt?.kind === 'restored') {
    return `${notReset} ${result.receipt.text} Read ${path} again and make sure it holds the current task.`;
  }
  if (!result.revision || !result.turns?.some(turn => turn.text.trim() !== '')) {
    return `${notReset} Your Working Context ${path} is missing or empty and there is no earlier revision to restore. Write the current task, decisions and next step into it.`;
  }
  try {
    const bytes = lib.readWorkingContextFile(join(input.cwd, path), lib.READ_MAX_FILE_BYTES);
    if (bytes === 'too-large') return `${notReset} Your Working Context exceeds the 16 MiB read limit. Offload large content with source pointers before resetting.`;
    if (!Buffer.isBuffer(bytes) || !bytes.length) return `${notReset} Your Working Context cannot be read safely. Repair it before resetting.`;
  } catch { return `${notReset} Your Working Context cannot be checked safely. Repair it before resetting.`; }
  // The budget check (new_context only): refuse while the file is over its budget, so that after the
  // reset its read-back fits in the new window with room left to work. The separate byte limit applies above:
  // `context-engine read` pages supported files up to 16 MiB.
  const b = result.budget;
  if (check.budget && b?.overBudget) {
    const n = (x: number) => x.toLocaleString('en-US');
    return `${notReset} Your Working Context ${path} is ~${n(b.approxTokens)} tokens, over its ~${n(b.budgetTokens)}-token budget: after a reset you read it back into the new window as tool output (\`context-engine read\`, in parts), and it must fit there with room left to work. Bring it under ~${n(b.budgetTokens)} tokens first; what to keep is up to you, and anything you take out stays in the Event Log (recall).`;
  }
  return null;
}

/** A call that reads or edits the Working Context (or files beside it), or reads it back with `context-engine read`. */
function touchesWorkingContext(input: HookInput): boolean {
  const data = input.tool_input as Record<string, unknown> | undefined;
  if (!data || typeof data !== 'object') return false;
  const managedPath = (path: string) => path.replaceAll('\\', '/').split('/').includes(lib.WORKING_CONTEXT_DIR);
  for (const key of ['file_path', 'path', 'filename']) {
    if (typeof data[key] === 'string' && managedPath(data[key] as string)) return true;
  }
  // Recognize only simple, unambiguous reads or truncation of a managed path.
  // Arbitrary shell text may mention a path as search data; retain its output.
  const command = typeof data.command === 'string' ? data.command : '';
  const read = /^\s*(?:cat|head|tail)\s+(['"]?)([^\s'";|&<>]+)\1\s*$/.exec(command);
  const truncate = /^\s*:\s*>\s*(['"]?)([^\s'";|&<>]+)\1\s*$/.exec(command);
  const coreRead = /^[ \t]*context-engine(?:-codex)?[ \t]+read(?:[ \t]+(?:[A-Za-z0-9_.:/=-]+|"[A-Za-z0-9_.:/=-]+"|'[A-Za-z0-9_.:/=-]+'|"\$CODEX_THREAD_ID"))*[ \t]*$/.test(command);
  const nodeRead = /^[ \t]*(?:node|\/[^\s'";|&<>`$]+\/node)[ \t]+(?:"([^"`$]+)"|'([^']+)'|([^\s'";|&<>`$]+))[ \t]+(read(?:[ \t]+(?:[A-Za-z0-9_.:/=-]+|"[A-Za-z0-9_.:/=-]+"|'[A-Za-z0-9_.:/=-]+'|"\$CODEX_THREAD_ID"))*[ \t]*)$/.exec(command);
  const cli = process.env.CONTEXT_ENGINE_CLI || fileURLToPath(new URL('../../../../core/cli.ts', import.meta.url));
  const directRead = !!nodeRead && resolve(input.cwd, nodeRead[1] ?? nodeRead[2] ?? nodeRead[3]!) === resolve(cli);
  return (!!read && managedPath(read[2]!)) || (!!truncate && managedPath(truncate[2]!)) || coreRead || directRead;
}

function emit(output: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

function responseText(input: HookInput): string {
  return typeof input.tool_response === 'string' ? input.tool_response : JSON.stringify(input.tool_response ?? null);
}

const RESET_MARKER = 'Context window reset (new_context). Everything above happened before this point: steps recorded as done are done. Continue from here.';
/**
 * The same for a reset the agent did not ask for (Codex's token limit, a manual /compact), with its
 * Delivery Mode (core CODEX_TOKEN_LIMIT_RESET). Static text.
 */
const backstopMarker = (delivery: string, manual: boolean): string =>
  `Context window reset (${manual ? 'manual compaction' : 'token limit'}). Delivery Mode: ${delivery}. Everything above happened before this point: steps recorded as done are done. The new window holds none of it: read this file back with \`context-engine read\`, read every part, then continue from here.`;
/** Set by resetRefusal: whether the file's last turn is already a reset marker. */
let lastTurnIsReset = false;

function renderToolCall(input: HookInput): string {
  // After a reset the recorded user request is the only request the model sees, and it reads like a
  // fresh instruction (measured: gpt-6-luna redid finished steps). Mark where each reset happened.
  if (input.tool_name === 'new_context') return RESET_MARKER;
  const toolInput = input.tool_input as { command?: unknown } | undefined;
  const call = typeof toolInput?.command === 'string' ? toolInput.command : JSON.stringify(toolInput ?? null);
  return `${input.tool_name}: ${call}\n${responseText(input)}`;
}

interface CoreResult {
  ok: boolean;
  revision?: number;
  workingContext?: string;
  receipt?: { kind: 'committed' | 'restored' | 'stale'; text: string; stale?: { count: number } };
  budget?: Core.BudgetReport;
  turns?: Array<{ role: string; text: string }>;
}

/**
 * One core call through the CLI. Codex may run the hooks of parallel tool calls at the same time,
 * all presenting the same owner; the core serializes them per session (core/lock.ts `serialized`).
 */
function core(input: HookInput, command: 'record' | 'sync', events?: unknown[], maxBytes?: number): CoreResult {
  const cli = process.env.CONTEXT_ENGINE_CLI || 'context-engine';
  const hardLimit = process.env.CONTEXT_ENGINE_HARD_LIMIT || String(DEFAULT_HARD_LIMIT);
  const args = [command, '--session', input.session_id, '--project', input.cwd, '--runner', RUNNER, '--hard-limit', hardLimit, '--owner-pid', String(runnerPid()), '--if-enabled', '--budget', String(budgetTokens)];
  if(maxBytes!==undefined)args.push('--max-context-bytes',String(maxBytes));
  const [file, argv] = /\.[cm]?[jt]s$/.test(cli) ? [process.execPath, [cli, ...args]] : [cli, args];
  // JSON can escape each character into six bytes, in both text and parsed turns.
  // Size for the supported 16 MiB payload envelope as well as the character hard limit.
  const maxBuffer = Math.max(16 * 1024 * 1024 * 12, Math.ceil((Number(hardLimit) || DEFAULT_HARD_LIMIT) * 12)) + 1024 * 1024;
  // PreCompact can sync, append its marker, then recheck: all three calls plus
  // the one-second intent wait must leave room under the host's 30-second limit.
  const timeout=input.hook_event_name==='PreCompact'?5000:20_000;
  const r = spawnSync(file, argv, { maxBuffer, input: events ? JSON.stringify(events) : '', encoding: 'utf8', timeout });
  let out: CoreResult | undefined;
  try {
    out = JSON.parse(r.stdout) as CoreResult;
  } catch {}
  if (out?.ok && (out as { active?: boolean }).active === false) throw new Inactive();
  if (!out?.ok) {
    const why = r.error?.message ?? (out ? JSON.stringify(out) : r.stderr.trim() || `exit ${r.status}`);
    throw new CoreUnavailable(`context-engine ${command} failed: ${why}`);
  }
  return out;
}

function log(e: unknown): void {
  process.stderr.write(`[context-engine codex hook] ${e instanceof Error ? e.message : String(e)}\n`);
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'fish', 'ash', 'busybox']);

/**
 * The session lock owner: the Codex process that runs this hook. Codex spawns hooks as
 * `$SHELL -lc "<command>"`, and the shell may or may not exec us, so walk up past any shells to the
 * first non-shell ancestor. That process lives as long as the Codex session, so every hook of the
 * session presents the same owner to the core. Where /proc is unavailable, falls back to the parent.
 */
function runnerPid(): number {
  let pid = process.ppid;
  for (let depth = 0; depth < 8; depth++) {
    const stat = procStat(pid);
    if (!stat || !SHELLS.has(stat.comm.replace(/^-/, ''))) return pid;
    pid = stat.ppid;
  }
  return pid;
}

function procStat(pid: number): { comm: string; ppid: number } | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const comm = stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')'));
    const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    return Number.isSafeInteger(ppid) && ppid > 0 ? { comm, ppid } : null;
  } catch {
    return null;
  }
}

let event: HookInput | undefined;
try {
  event = JSON.parse(readFileSync(0, 'utf8')) as HookInput;
  await main(event);
} catch (e) {
  if (!(e instanceof Inactive)) {
    log(e);
    // Fail closed for a verified active project's reset (most often loading the core from the
    // checkout), nothing can show the Working Context is usable, and refusing costs only a retry.
    // The path is spelled out here because the core that knows it may be what failed to load.
    if (event && isResetGate(event) && !event.agent_id && confirmedParticipation) {
      denyReset(e instanceof PendingPrompt ? e.message : `${NOT_RESET} The Context Engine core could not be loaded or reached, so your Working Context .context-engine/${event.session_id}/context.md could not be checked, and resetting onto a file that cannot be delivered would lose the conversation. Carry on in this window for now (if this keeps happening, reinstall or uninstall Context Engine).`);
    } else if(event && !event.agent_id && confirmedParticipation && (event.hook_event_name==='UserPromptSubmit'||event.hook_event_name==='PreCompact')) {
      emit({continue:false,stopReason:'Context Engine: this request/compaction was stopped because the user request could not be safely recorded. Retry the original request after repairing storage, or disable Context Engine. No reset acceptance is claimed.'});
    }
  }
  // Other failures retain native fallback. Exit 0 with no stdout has no control effect.
}
