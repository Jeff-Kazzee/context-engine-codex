// The edit ledger: how setup changes files it doesn't own and puts them back.
//
// Before an edit, every file the edit may change gets a byte backup in a timestamped directory,
// and the watched directories are listed. After it, the new bytes are kept too, and whatever the
// edit created is recorded. To revert:
//
// 1. `assess` (before any runner command runs): a file is "unchanged otherwise" when, with our own
//    entries stripped, it reads the same as right after the edit (whitespace and JSON key order
//    aside). Anything else is a change someone else made since.
// 2. The runner's own removal commands run (the caller's job).
// 3. `revert`: an unchanged-otherwise file gets its exact original bytes back (or is deleted, if
//    it didn't exist). A changed one keeps the other changes: only our entries are removed (a
//    minimal reverse edit), and the report says so. Created files are removed when they are still
//    as the edit left them, our namespaced dirs are removed, and created dirs that are now empty go.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** How to recognise and remove our entries in one file. */
export interface Rule {
  /** The text with our entries removed. `before` is the file as it was before the edit (null: absent). */
  strip(text: string, before: string | null): string;
  /** A form that ignores formatting, for "unchanged otherwise". */
  canon(text: string): string;
}

export interface Ledger {
  version: 1;
  /** What made the edit, e.g. 'claude', 'codex', 'project'. */
  kind: string;
  at: string;
  /** The timestamped backup directory (this ledger lives in it). */
  dir: string;
  files: Array<{ path: string; before: string | null; after: string | null }>;
  createdFiles: Array<{ path: string; sha: string }>;
  createdDirs: string[];
  /** Directories that are ours by name; removed whole if they didn't exist before. */
  namespaced: Array<{ path: string; existed: boolean }>;
  /** Free-form facts for the caller (e.g. the project root). */
  extra: Record<string, unknown>;
}

export interface Snapshot extends Omit<Ledger, 'createdFiles' | 'createdDirs'> {
  watch: string[];
  listing: string[];
}

export interface FileReport {
  path: string;
  outcome: 'restored' | 'deleted' | 'reverse-edited' | 'unchanged' | 'missing';
  /** Where the original bytes are kept, for a reverse edit. */
  backup?: string;
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const readText = (path: string): string | null => (existsSync(path) ? readFileSync(path, 'utf8') : null);

/** Every path under each root, the root included, without following symlinks. */
function list(roots: string[]): string[] {
  const out: string[] = [];
  const walk = (p: string) => {
    let st;
    try {
      st = lstatSync(p);
    } catch {
      return;
    }
    out.push(st.isDirectory() ? `${p}/` : p);
    if (st.isDirectory()) for (const name of readdirSync(p)) walk(join(p, name));
  };
  for (const r of roots) walk(r);
  return out;
}

export function timestamp(d = new Date()): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

/** Backs up `files` byte for byte into a new timestamped dir under `backupRoot`, and lists `watch`. */
export function takeSnapshot(opts: { backupRoot: string; kind: string; files: string[]; watch: string[]; namespaced: string[]; extra?: Record<string, unknown> }): Snapshot {
  const at = new Date();
  let dir = join(opts.backupRoot, `${opts.kind}-${timestamp(at)}`);
  for (let n = 2; existsSync(dir); n++) dir = join(opts.backupRoot, `${opts.kind}-${timestamp(at)}-${n}`);
  mkdirSync(join(dir, 'before'), { recursive: true, mode: 0o700 });
  mkdirSync(join(dir, 'after'), { mode: 0o700 });
  const files = opts.files.map((path, i) => {
    const copy = join(dir, 'before', `${i}-${path.split('/').at(-1)}`);
    if (!existsSync(path)) return { path, before: null, after: null };
    copyFileSync(path, copy);
    return { path, before: copy, after: null };
  });
  return {
    version: 1,
    kind: opts.kind,
    at: at.toISOString(),
    dir,
    files,
    namespaced: opts.namespaced.map((path) => ({ path, existed: existsSync(path) })),
    extra: opts.extra ?? {},
    watch: opts.watch,
    listing: list(opts.watch),
  };
}

/** Records the edit's result next to the backups and returns the ledger. */
export function completeLedger(s: Snapshot): Ledger {
  const files = s.files.map((f, i) => {
    if (!existsSync(f.path)) return { ...f, after: null };
    const copy = join(s.dir, 'after', `${i}-${f.path.split('/').at(-1)}`);
    copyFileSync(f.path, copy);
    return { ...f, after: copy };
  });
  const before = new Set(s.listing);
  const tracked = new Set(s.files.map((f) => f.path));
  const created = list(s.watch).filter((p) => !before.has(p) && !tracked.has(p));
  const ledger: Ledger = {
    version: 1,
    kind: s.kind,
    at: s.at,
    dir: s.dir,
    files,
    createdFiles: created.filter((p) => !p.endsWith('/')).map((path) => ({ path, sha: sha(readFileSync(path)) })),
    createdDirs: created.filter((p) => p.endsWith('/')).map((p) => p.slice(0, -1)),
    namespaced: s.namespaced,
    extra: s.extra,
  };
  writeFileSync(join(s.dir, 'ledger.json'), `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
  return ledger;
}

export function readLedger(dir: string): Ledger {
  return JSON.parse(readFileSync(join(dir, 'ledger.json'), 'utf8')) as Ledger;
}

/** Per file: true when nothing but our own entries changed since the edit. Call before runner commands. */
export function assess(l: Ledger, rules: Record<string, Rule>): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const f of l.files) {
    const rule = rules[f.path];
    const before = f.before ? readText(f.before) : null;
    const after = f.after ? readText(f.after) : null;
    const now = readText(f.path);
    const form = (t: string | null) => (t === null ? '\u0000absent' : rule ? rule.canon(rule.strip(t, before)) : t);
    out[f.path] = form(now) === form(after);
  }
  return out;
}

/** Puts files back (see the module comment) and cleans up what the edit created. */
export function revert(l: Ledger, rules: Record<string, Rule>, unchanged: Record<string, boolean>): FileReport[] {
  const reports: FileReport[] = [];
  for (const f of l.files) {
    const before = f.before ? readFileSync(f.before) : null;
    if (unchanged[f.path]) {
      if (before) {
        mkdirSync(dirname(f.path), { recursive: true });
        writeFileSync(f.path, before);
        reports.push({ path: f.path, outcome: 'restored' });
      } else {
        if (existsSync(f.path)) unlinkSync(f.path);
        reports.push({ path: f.path, outcome: 'deleted' });
      }
      continue;
    }
    const now = readText(f.path);
    if (now === null) {
      reports.push({ path: f.path, outcome: 'missing', backup: f.before ?? undefined });
      continue;
    }
    const rule = rules[f.path];
    const stripped = rule ? rule.strip(now, before?.toString('utf8') ?? null) : now;
    if (stripped !== now) writeFileSync(f.path, stripped);
    reports.push({ path: f.path, outcome: 'reverse-edited', backup: f.before ?? undefined });
  }
  for (const n of l.namespaced) if (!n.existed) rmSync(n.path, { recursive: true, force: true });
  for (const c of l.createdFiles) {
    if (existsSync(c.path) && sha(readFileSync(c.path)) === c.sha) unlinkSync(c.path);
  }
  for (const d of [...l.createdDirs].sort((a, b) => b.length - a.length)) {
    try {
      rmdirSync(d);
    } catch {
      // Not empty (someone else uses it now) or already gone: leave it.
    }
  }
  return reports;
}
