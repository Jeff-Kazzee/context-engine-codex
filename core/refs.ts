// Stale-reference markers (experiment, off by default; issue #20).
//
// The agent may cite code in its Working Context with a compact marker:
//   ⟦src:path/to/file.ts#L10-20@1a2b3c4d⟧   a line span (8 hex of sha256 of those lines)
//   ⟦src:path/to/file.ts@1a2b3c4d⟧          a whole file (8 hex of sha256 of its content)
//   ⟦commit:0123456789ab⟧                   a commit (12 hex)
// `cite()` (CLI: `context-engine cite <path>[#Lx-y] | commit:<rev>`) prints one. At sync, with the
// experiment on, the core re-checks each cited target and lists the stale ones in the receipt.
// With the experiment off none of this runs: no parsing, no file reads, no guidance text.
import { spawnSync } from 'node:child_process';
import { relative, resolve, sep } from 'node:path';
import { readConfined, sha, type Refusal } from './store.ts';

/**
 * changed: the cited content differs. moved: the cited lines are intact but now at `to`.
 * missing: the file no longer exists, or the commit is not in the repository.
 * rewritten: the commit exists but no branch, tag or HEAD reaches it (amended, rebased, reset).
 */
export type StaleReason = 'changed' | 'moved' | 'missing' | 'rewritten';

export interface StaleRef {
  /** The marker exactly as it appears in the Working Context. */
  marker: string;
  reason: StaleReason;
  /** For 'moved': the span's new location, e.g. 'L12-14'. */
  to?: string;
}

/** Added to a receipt when the experiment is on and cited references are stale. */
export interface StaleReport {
  /** How many distinct cited references are stale. */
  count: number;
  /** At most MAX_STALE_LISTED of them, in order of first appearance. */
  refs: StaleRef[];
}

export const MAX_STALE_LISTED = 5;

/** One line for adapters to add to the model's guidance only when the stale-refs experiment is on. */
export const STALE_REFS_GUIDANCE =
  'To cite code you rely on, run `context-engine cite <path>#L<from>-<to>` (or `cite commit:<rev>`) and paste the ⟦…⟧ marker it prints; a later receipt lists cited code that has since changed.';

/** Whether an experiment is on: the explicit list if given, else $CONTEXT_ENGINE_EXPERIMENTS (comma-separated). */
export function experimentOn(name: 'stale-refs', explicit?: string[]): boolean {
  const list = explicit ?? (process.env.CONTEXT_ENGINE_EXPERIMENTS ?? '').split(',');
  return list.some((e) => e.trim() === name);
}

const hash8 = (text: string) => sha(text).slice(0, 8);

/** Lines a..b (1-based, inclusive) of `text`, or null if the file is shorter than b. */
function span(text: string, a: number, b: number): string | null {
  const all = text.split('\n');
  return b <= all.length ? all.slice(a - 1, b).join('\n') : null;
}

const validRange = (a: number, b: number) => Number.isSafeInteger(a) && Number.isSafeInteger(b) && a >= 1 && b >= a;

interface RelocationBudget { candidates: number; work: number }
// Per check: bound window hashes and their UTF-8/line work; exhausted searches are changed.
const relocationBudget = (): RelocationBudget => ({ candidates: 4096, work: 1024 * 1024 });

const lineRange = (a: number, b: number) => `L${a}${b === a ? '' : `-${b}`}`;

/** A project-relative, '/'-separated path that stays inside the project, or null. */
function insideProject(projectRoot: string, path: string): string | null {
  const rel = relative(resolve(projectRoot), resolve(projectRoot, path)).split(sep).join('/');
  return rel && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('/') ? rel : null;
}

const REFUSED: Record<Refusal, string> = {
  outside: 'not inside the project (it leads out through a symbolic link)',
  credential: 'it is a credential file, which is never read',
  'not-a-file': 'not a regular file with a single name (a symbolic link, a hard link, or a special file), which is never read',
};

/** Returns the marker for `<path>[#Lx[-y]]` (relative to `projectRoot`, or absolute inside it) or `commit:<rev>`. */
export function cite(projectRoot: string, ref: string): string {
  if (ref.startsWith('commit:')) {
    const r = git(projectRoot, 'rev-parse', '--verify', '--quiet', `${ref.slice(7)}^{commit}`);
    if (r.status !== 0) throw new Error(`no commit ${ref.slice(7)} in ${projectRoot}`);
    return `⟦commit:${r.stdout.trim().slice(0, 12)}⟧`;
  }
  const m = /^(.+?)(?:#L(\d+)(?:-(\d+))?)?$/.exec(ref)!;
  const rel = insideProject(projectRoot, m[1]!);
  if (!rel || !/^[\w./+-]+$/.test(rel)) throw new Error(`cannot cite ${m[1]}: not inside the project, or the path has characters other than letters, digits, '.', '_', '+', '-', '/'`);
  if (m[2] !== undefined && !validRange(Number(m[2]), Number(m[3] ?? m[2]))) throw new Error('citation line range must use positive ordered safe integers');
  // Lexically inside is not enough: a symlink in the project can lead anywhere.
  const target = readConfined(projectRoot, rel);
  if ('refused' in target) throw new Error(`cannot cite ${rel}: ${REFUSED[target.refused]}`);
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(target.bytes);
  if (m[2] === undefined) return `⟦src:${rel}@${hash8(text)}⟧`;
  const a = Number(m[2]);
  const b = m[3] === undefined ? a : Number(m[3]);
  const lines = span(text, a, b);
  if (lines === null) throw new Error(`${rel} has no lines ${a}-${b}`);
  return `⟦src:${rel}#${lineRange(a, b)}@${hash8(lines)}⟧`;
}

const MARKER = /⟦(?:src:([\w./+-]+)(?:#L(\d+)(?:-(\d+))?)?@([0-9a-f]{8})|commit:([0-9a-f]{7,40}))⟧/g;

/** Checks every marker in `text` against the project. Returns undefined when nothing is stale. */
export function checkRefs(projectRoot: string, text: string): StaleReport | undefined {
  const stale: StaleRef[] = [];
  const seen = new Set<string>();
  const budget = relocationBudget();
  let inRepo: boolean | undefined;
  for (const m of text.matchAll(MARKER)) {
    const marker = m[0];
    if (seen.has(marker)) continue;
    seen.add(marker);
    const [, path, a, b, hash, commit] = m;
    let found: Omit<StaleRef, 'marker'> | null;
    if (commit !== undefined) {
      inRepo ??= git(projectRoot, 'rev-parse', '--is-inside-work-tree').status === 0;
      found = inRepo ? checkCommit(projectRoot, commit) : null;
    } else {
      const rel = insideProject(projectRoot, path!);
      if (rel === null) continue;
      const lines: [number, number] | null = a === undefined ? null : [Number(a), Number(b ?? a)];
      found = lines && !validRange(...lines) ? { reason: 'changed' } : checkSource(projectRoot, rel, lines, hash!, budget);
    }
    if (found) stale.push({ marker, ...found });
  }
  if (stale.length === 0) return undefined;
  return { count: stale.length, refs: stale.slice(0, MAX_STALE_LISTED) };
}

function checkSource(projectRoot: string, rel: string, lines: [number, number] | null, hash: string, budget: RelocationBudget): Omit<StaleRef, 'marker'> | null {
  let content: string;
  try {
    const target = readConfined(projectRoot, rel);
    // A marker that leads out of the project, to a credential file, or to anything but one regular
    // file is never followed or reported.
    if ('refused' in target) return null;
    try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(target.bytes); }
    catch { return { reason: 'changed' }; }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? { reason: 'missing' } : null;
  }
  if (lines === null) return hash8(content) === hash ? null : { reason: 'changed' };
  const [from, to] = lines;
  const target = span(content, from, to);
  if (target !== null && hash8(target) === hash) return null;
  const at = relocate(content, to - from + 1, hash, from, budget);
  return at === null ? { reason: 'changed' } : { reason: 'moved', to: lineRange(at, at + to - from) };
}

/** First line of the window of `size` lines hashing to `hash` that is nearest `near`, or null. */
function relocate(content: string, size: number, hash: string, near: number, budget: RelocationBudget): number | null {
  const all = content.split('\n');
  if (size > all.length) return null;
  let work = size;
  for (let n = 0; n < size; n++) work += all[n]!.length * 3;
  let best: number | null = null;
  for (let i = 0; i + size <= all.length; i++) {
    if (budget.candidates <= 0 || work > budget.work) return null;
    budget.candidates--; budget.work -= work;
    if (hash8(all.slice(i, i + size).join('\n')) === hash && (best === null || Math.abs(i + 1 - near) < Math.abs(best - near))) best = i + 1;
    if (i + size < all.length) work += (all[i + size]!.length - all[i]!.length) * 3;
  }
  return best;
}

function checkCommit(projectRoot: string, commit: string): Omit<StaleRef, 'marker'> | null {
  if (git(projectRoot, 'cat-file', '-e', `${commit}^{commit}`).status !== 0) return { reason: 'missing' };
  const refs = git(projectRoot, 'for-each-ref', '--count=1', '--format=x', '--contains', commit);
  if (refs.status === 0 && refs.stdout.trim()) return null;
  return git(projectRoot, 'merge-base', '--is-ancestor', commit, 'HEAD').status === 0 ? null : { reason: 'rewritten' };
}

function git(cwd: string, ...args: string[]) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 1000, maxBuffer: 65536,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0' } });
}

export function staleText(report: StaleReport): string {
  const listed = report.refs.map((r) => `${r.marker} (${r.reason}${r.to ? ` to ${r.to}` : ''})`).join(', ');
  const more = report.count > report.refs.length ? `, and ${report.count - report.refs.length} more` : '';
  const noun = report.count === 1 ? 'cited reference is' : 'cited references are';
  return `Context Engine: ${report.count} ${noun} stale: ${listed}${more}. Re-read and re-cite, or drop them.`;
}
