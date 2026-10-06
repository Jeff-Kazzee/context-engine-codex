// Recall: on-demand, read-only search of one session's Event Log. Takes no session lock and never
// touches the Working Context or any revision, so the agent can call it from its own shell
// while the adapter holds the session. Its only write is one appended Event Log line per call
// (for eval accounting): an O_APPEND write under the shared append lease, completed even on short writes. Where that
// write is not permitted (Codex's workspace-write sandbox), the result is still returned, marked
// `accounting: 'skipped'`.
import { createHash } from 'node:crypto';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { appendLog, assertSessionId, layout, readLog, readWorkingContextFile, resolveStateRoot, workingContextRelPath } from './store.ts';
import type { RunnerEvent } from './session.ts';
import { approxTokens, formatInt } from './size.ts';
import { SerializeTimeout } from './lock.ts';

export interface SessionRef {
  projectRoot: string;
  sessionId: string;
  /** State root override, as for openSession. */
  stateDir?: string;
}

/**
 * Searchable Event Log items have stable ids: `e<n>` is runner event n (its sequence number), and
 * `r<n>` is the n-th rejected Working Context edit (text the core refused and restored over).
 */
export interface RecallHit {
  /** Event id, for `show`. */
  id: string;
  /** The runner event's role, or 'rejected-edit'. */
  role: string;
  /** A short window of the event's text around the first match. */
  snippet: string;
}

export interface RecallResult {
  query: string;
  hits: RecallHit[];
  /** Matching events in the log, including any left out of `hits`. */
  total: number;
  /** True when matches were left out to stay within the byte bound. */
  truncated: boolean;
  /** 'skipped' when this call could not be logged for eval accounting (see `account`). */
  accounting?: 'skipped';
  note?: string;
}

interface Item {
  id: string;
  role: string;
  text: string;
}

/**
 * The project a recall/show caller is in: the nearest directory at or above `cwd` that holds this
 * session's Working Context directory (`.context-engine/<session>/`). Throws when there is none, so
 * a session of another project, or an id this project never had, is refused.
 *
 * This keeps an agent from reading another project's session by accident (a wrong id, a copied
 * command). It is not a security boundary: any process running as the same user can read the state
 * directory directly.
 */
export function sessionProjectFrom(cwd: string, sessionId: string): string {
  assertSessionId(sessionId);
  for (let dir = realpathSync(cwd); ; dir = dirname(dir)) {
    const wcDir = dirname(join(dir, workingContextRelPath(sessionId)));
    if (existsSync(wcDir) && statSync(wcDir).isDirectory()) return dir;
    if (dirname(dir) === dir) throw new Error(`no session ${sessionId} in this project (no ${dirname(workingContextRelPath(sessionId))}/ at or above ${cwd})`);
  }
}

/** The session's Event Log path. Session ids are validated, so no path leaves the session's directory. */
function eventLog(ref: SessionRef): string {
  const { events } = layout(ref.projectRoot, ref.sessionId, resolveStateRoot(ref.stateDir));
  if (!existsSync(events)) throw new Error(`no session ${ref.sessionId} in this project (no Event Log)`);
  return events;
}

function items(log: string): Item[] {
  const out: Item[] = [];
  let rejected = 0;
  for (const entry of readLog(log)) {
    if (entry.type === 'runner-events') {
      for (const { seq, event } of entry.events as Array<{ seq: number; event: RunnerEvent }>) {
        // Structured runner evidence lives in the log, outside the materialized Working Context.
        const evidence = event.item === undefined ? '' : `\n${JSON.stringify(event.item)}`;
        out.push({ id: `e${seq}`, role: event.role, text: event.text + evidence });
      }
    } else if (entry.type === 'restored' && typeof entry.rejected === 'string') {
      out.push({ id: `r${++rejected}`, role: 'rejected-edit', text: entry.rejected });
    }
  }
  return out;
}

/**
 * One line of agent guidance for adapters to include in their instructions. `<session-id>` is a
 * literal placeholder: an adapter that knows the id may substitute it.
 */
export const RECALL_GUIDANCE =
  "To get back exact evidence you dropped from your Working Context, search this session's Event Log read-only: `context-engine recall --session <session-id> <words>` returns short snippets with event ids (bounded output), and `context-engine show --session <session-id> <event-id>` prints one event.";

/** Upper bound on a recall result, in UTF-8 bytes of its JSON (the CLI's whole output line included). */
export const RECALL_MAX_BYTES = 4096;
const SKIPPED_NOTE_TEXT = 'Not counted in the Event Log (not writable here, e.g. a sandboxed shell); the result is complete.';
/** Room left for the CLI's `{"ok":true,...}` envelope and newline, and a possible accounting note. */
const ENVELOPE_BYTES = 32 + Buffer.byteLength(JSON.stringify({ accounting: 'skipped', note: SKIPPED_NOTE_TEXT }));
const MAX_QUERY_CHARS = 256;
const SNIPPET_CHARS = 240;
const SNIPPET_LEAD = 80;

const jsonBytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v));

/** Never cut between the halves of a surrogate pair. */
function safeIndex(text: string, i: number): number {
  const c = text.charCodeAt(i);
  return c >= 0xdc00 && c <= 0xdfff ? i - 1 : i;
}

function snippet(text: string, at: number): string {
  if (text.length <= SNIPPET_CHARS) return text;
  const start = safeIndex(text, Math.max(0, at - SNIPPET_LEAD));
  const end = safeIndex(text, Math.min(text.length, start + SNIPPET_CHARS));
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

/**
 * Case-insensitive search over the session's runner events and rejected edits, newest first: an
 * item matches when its text contains every whitespace-separated word of the query. The result's
 * JSON is at most RECALL_MAX_BYTES; `truncated` says matches were left out. Throws on an empty
 * query, a query over MAX_QUERY_CHARS, an invalid session id, or a session with no Event Log.
 */
export function recall(opts: SessionRef & { query: string }): RecallResult {
  if (opts.query.trim() === '') throw new Error('recall needs a non-empty query');
  if (opts.query.length > MAX_QUERY_CHARS) throw new Error(`recall query is over ${MAX_QUERY_CHARS} characters`);
  const log = eventLog(opts);
  const terms = opts.query.toLowerCase().split(/\s+/).filter(Boolean);
  const matches: RecallHit[] = [];
  for (const it of items(log).reverse()) {
    const lower = it.text.toLowerCase();
    if (terms.every((t) => lower.includes(t))) matches.push({ id: it.id, role: it.role, snippet: snippet(it.text, lower.indexOf(terms[0]!)) });
  }
  const result: RecallResult = { query: opts.query, hits: [], total: matches.length, truncated: true };
  let size = jsonBytes(result);
  for (const hit of matches) {
    const add = jsonBytes(hit) + (result.hits.length ? 1 : 0);
    if (size + add > RECALL_MAX_BYTES - ENVELOPE_BYTES) break;
    result.hits.push(hit);
    size += add;
  }
  result.truncated = result.hits.length < matches.length;
  return { ...result, ...account(log, { type: 'recall', query: opts.query, total: result.total, returned: result.hits.length, truncated: result.truncated }) };
}

/** Upper bound on a show result, in UTF-8 bytes of its JSON (the CLI's whole output line included). */
export const SHOW_MAX_BYTES = 16_384;

export interface ShowResult {
  id: string;
  role: string;
  /** The event's text: whole, or its beginning when `truncated`. */
  text: string;
  /** Length of the whole text, in characters. */
  chars: number;
  truncated: boolean;
  accounting?: 'skipped';
  note?: string;
}

const SKIPPED_NOTE = SKIPPED_NOTE_TEXT;

/**
 * Logs one recall/show call for eval accounting. The read already succeeded, so a log that can't
 * be appended to (a workspace-write sandbox, a read-only state dir) never costs the agent its
 * answer: the result says accounting was skipped instead.
 */
function account(log: string, entry: Record<string, unknown>): { accounting?: 'skipped'; note?: string } {
  try {
    appendLog(log, entry, { timeoutMs: 0 });
    return {};
  } catch (e) {
    if (e instanceof SerializeTimeout) return { accounting: 'skipped', note: SKIPPED_NOTE };
    if (['EACCES', 'EPERM', 'EROFS', 'ENOSPC', 'EDQUOT', 'EIO'].includes((e as NodeJS.ErrnoException).code ?? '')) return { accounting: 'skipped', note: SKIPPED_NOTE };
    throw e;
  }
}

/**
 * One event by the id recall gave, with its JSON at most SHOW_MAX_BYTES. Throws if this session's
 * Event Log has no such event. Logged as a `show` entry, like recall.
 */
export function show(opts: SessionRef & { id: string }): ShowResult {
  const log = eventLog(opts);
  const it = items(log).find((i) => i.id === opts.id);
  if (!it) throw new Error(`no event ${JSON.stringify(opts.id)} in session ${opts.sessionId}`);
  const whole: ShowResult = { id: it.id, role: it.role, text: it.text, chars: it.text.length, truncated: false };
  const budget = SHOW_MAX_BYTES - ENVELOPE_BYTES;
  let result = whole;
  if (jsonBytes(whole) > budget) {
    // Longest prefix that fits. JSON escaping makes bytes per character vary, so search for it.
    const cut = (n: number): ShowResult => ({ ...whole, text: it.text.slice(0, safeIndex(it.text, n)), truncated: true });
    let lo = 0;
    let hi = it.text.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (jsonBytes(cut(mid)) <= budget) lo = mid;
      else hi = mid - 1;
    }
    result = cut(lo);
  }
  return { ...result, ...account(log, { type: 'show', id: it.id, chars: result.chars, truncated: result.truncated }) };
}

// ---- read-back in parts ----

/**
 * Codex's cap on one tool output, in bytes (codex-cli 0.160.0, rust-v0.160.0 source): exec output
 * is cut to `max_output_tokens`, default `DEFAULT_MAX_OUTPUT_TOKENS = 10_000`
 * (codex-rs/core/src/unified_exec/mod.rs:79), never above the model's `truncation_policy` (10,000
 * tokens for every model in codex-rs/models-manager/models.json), and the code-mode `exec` tool cuts
 * its result the same way (codex-rs/core/src/tools/code_mode/mod.rs:316). Tokens are counted as
 * bytes / 4 (`APPROX_BYTES_PER_TOKEN`, codex-rs/utils/string/src/truncate.rs:4): 40,000 bytes.
 * Past it the middle of the output is dropped.
 */
export const CODEX_TOOL_OUTPUT_CAP_BYTES = 10_000 * 4;

/** Upper bound on one `read` output (header and text), in UTF-8 bytes: well under the Codex cap. */
export const READ_MAX_BYTES = 32_000;
/** Room kept for the header line (session ids are at most 128 characters). */
const HEADER_BYTES = 640;

export interface ReadResult {
  /** The header line, then this part of the file, byte for byte. */
  text: string;
  part: number;
  parts: number;
  /** Content cursor required on later parts; a changed file refuses the read. */
  sha: string;
  accounting?: 'skipped';
}

/**
 * Splits text into parts of at most `max` UTF-8 bytes, never inside a character: at the last line
 * break in the second half of the window, else (one very long line) at the window's end.
 */
function splitParts(text: string, max: number): string[] {
  const buf = Buffer.from(text, 'utf8');
  const parts: string[] = [];
  let start = 0;
  while (start < buf.length) {
    let end = Math.min(buf.length, start + max);
    if (end < buf.length) {
      const nl = buf.lastIndexOf(0x0a, end - 1);
      if (nl >= start + (max >> 1)) end = nl + 1;
      else while (end > start && (buf[end]! & 0xc0) === 0x80) end--; // never inside a character
    }
    parts.push(buf.subarray(start, end).toString('utf8'));
    start = end;
  }
  return parts.length ? parts : [''];
}

/**
 * One part of the session's Working Context file, as it is on disk now, behind a header line: the
 * part number, the total, the approximate size, and the command for the next part. Every output is
 * at most READ_MAX_BYTES, so it survives Codex's tool-output cap whole, and the parts put together
 * are the file byte for byte. Read-only; logged as a `read` entry for eval accounting (skipped
 * where the Event Log is not writable). Throws on a missing file or a part out of range.
 */
export const READ_MAX_FILE_BYTES = 16 * 1024 * 1024;

export function readWorkingContext(opts: SessionRef & { part?: number; sha?: string }): ReadResult {
  const log = eventLog(opts);
  const rel = workingContextRelPath(opts.sessionId);
  const path = join(realpathSync(opts.projectRoot), rel);
  const bytes = readWorkingContextFile(path, READ_MAX_FILE_BYTES);
  if (bytes === 'too-large') throw new Error(`Working Context exceeds the ${READ_MAX_FILE_BYTES}-byte read limit; refusing before loading its payload`);
  if (bytes === undefined) throw new Error(`no Working Context file at ${rel}`);
  if (bytes === 'not-a-file') throw new Error(`the Working Context ${rel} is a symbolic link or a hard link, which is never read; replace it with a regular file`);
  // Preserve a UTF-8 BOM too: every returned part must reconstruct the original bytes.
  const whole = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  const parts = splitParts(whole, READ_MAX_BYTES - HEADER_BYTES);
  const part = opts.part ?? 1;
  if (!Number.isSafeInteger(part) || part < 1 || part > parts.length) throw new Error(`no part ${part} of ${parts.length}: the Working Context has ${parts.length} part(s)`);
  const sum = createHash('sha256').update(bytes).digest('hex');
  if (part > 1 && opts.sha === undefined) throw new Error('later Working Context parts require the --sha digest from part 1; restart with part 1');
  if (opts.sha !== undefined && !/^[a-f0-9]{64}$/.test(opts.sha)) throw new Error('invalid --sha content digest');
  if (opts.sha !== undefined && opts.sha !== sum) throw new Error('Working Context changed; restart with part 1 rather than combining different revisions');
  const size = `~${formatInt(approxTokens(whole.length))} tokens in all`;
  const next = part < parts.length ? `Read every part; next: context-engine read --session ${opts.sessionId} --part ${part + 1} --sha ${sum}` : 'This is the last part.';
  const header = `[Context Engine: Working Context ${rel}, part ${part} of ${parts.length} (${size}). ${next}]`;
  const accounted = account(log, { type: 'read', part, parts: parts.length, sha: sum, chars: whole.length });
  return { text: `${header}\n${parts[part - 1]}`, part, parts: parts.length, sha: sum, ...(accounted.accounting ? { accounting: accounted.accounting } : {}) };
}
