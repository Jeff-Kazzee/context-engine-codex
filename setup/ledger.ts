// The edit ledger: how setup changes files it doesn't own and puts them back.
//
// Before an edit, every file the edit may change gets a byte backup in a timestamped directory,
// and the watched directories are listed. After it, the new bytes are kept too, and whatever the
// edit created is recorded. To revert:
//
// 1. `assess` (after runner removal commands finish): a file is "unchanged otherwise" when, with our own
//    entries stripped, it reads the same as right after the edit (whitespace and JSON key order
//    aside). Anything else is a change someone else made since.
// 2. Assessment uses the current bytes after the runner's removal commands (the caller's job).
// 3. `revert`: an unchanged-otherwise file gets its exact original bytes back (or is deleted, if
//    it didn't exist). A changed one keeps the other changes: only our entries are removed (a
//    minimal reverse edit), and the report says so. Created files are removed when they are still
//    as the edit left them, newly created explicit namespaces are removed; other owned created directories
//    are removed only when empty, and unowned directories remain.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, opendirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path';
import { closeSync, constants, fsyncSync, openSync } from 'node:fs';
import { openPrivateDirectory } from '../core/store.ts';
import { checkComponents, checkOwnedDirectory, checkOwnedFile, safeRead, safeRemove, safeRemoveTree, safeWrite } from './files.ts';
import { assertBackupSafe } from './config-safety.ts';

/** How to recognise and remove our entries in one file. */
export interface Rule {
  /** The text with our entries removed. `before` is the file as it was before the edit (null: absent). */
  strip(text: string, before: string | null): string;
  /** A form that ignores formatting, for "unchanged otherwise". */
  canon(text: string): string;
  /** Whether stripped text has no unmanaged content when the original file was absent. */
  empty?(text: string): boolean;
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
  /** New watched paths whose ownership is unknown; retained without reading their contents. */
  retainedPaths?: string[];
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
const readText = (path: string): string | null => safeRead(path)?.toString('utf8') ?? null;

/** Complete bounded ownership inventory; refuse rather than accept a partial walk. */
function list(roots: string[]): string[] {
  const out: string[] = [];
  let pathBytes = 0;
  const walk = (p: string, depth: number) => {
    if (depth > 64 || out.length >= 4096 || (pathBytes += Buffer.byteLength(p)) > 1024 * 1024) throw new Error('setup inventory exceeds entry, depth or path-byte limit; ownership was not accepted');
    let st;
    try {
      st = lstatSync(p);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw e;
    }
    out.push(st.isDirectory() ? `${p}/` : p);
    if (st.isDirectory()) {
      const directory = opendirSync(p);
      try { for (let entry; (entry = directory.readSync()) !== null;) walk(join(p, entry.name), depth + 1); }
      finally { directory.closeSync(); }
    }
  };
  for (const r of roots) walk(r, 0);
  return out;
}

export function timestamp(d = new Date()): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

/** Backs up `files` byte for byte into a new timestamped dir under `backupRoot`, and lists `watch`. */
export function takeSnapshot(opts: { backupRoot: string; kind: string; files: string[]; watch: string[]; namespaced: string[]; extra?: Record<string, unknown> }): Snapshot {
  for (const path of opts.watch) {
    checkComponents(path);
    try { if (!lstatSync(path).isDirectory()) throw new Error(`setup watched root is not a directory: ${path}`); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    checkOwnedDirectory(path);
  }
  for (const path of opts.namespaced) checkComponents(path);
  for (const path of opts.files) checkOwnedFile(path);
  const before=opts.files.map(path=>{const bytes=safeRead(path);assertBackupSafe(path,bytes);return bytes;});
  const at = new Date();
  checkComponents(opts.backupRoot);
  const parent = openPrivateDirectory(opts.backupRoot,{create:true})!;
  let dir: string;
  try {
    for (let n=1;;n++) {
      const name = `${opts.kind}-${timestamp(at)}${n===1?'':'-'+n}`;
      if (name.includes('/') || name.includes('\\') || name === '..') throw new Error('invalid snapshot kind');
      dir = join(opts.backupRoot,name);
      try { mkdirSync(join(`/proc/self/fd/${parent}`,name),{mode:0o700}); fsyncSync(parent); break; }
      catch(e) { if((e as NodeJS.ErrnoException).code!=='EEXIST') throw e; }
    }
  } finally {closeSync(parent);}
  for(const category of ['before','after']) closeSync(openPrivateDirectory(join(dir,category),{create:true})!);
  const files = opts.files.map((path, i) => {
    const copy = join(dir, 'before', `${i}-${path.split('/').at(-1)}`);
    const bytes = before[i]!;
    if (bytes === null) return { path, before: null, after: null };
    writeBackup(copy,bytes);
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

/** Exclusive backup writes through the verified private parent; planted copies are never followed. */
function writeBackup(path: string, bytes: Buffer): void {
  const parent = openPrivateDirectory(dirname(path))!;
  let fd: number | undefined;
  try {
    fd = openSync(join(`/proc/self/fd/${parent}`,path.split('/').at(-1)!),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    writeFileSync(fd,bytes); fsyncSync(fd); fsyncSync(parent);
  } finally {if(fd!==undefined)closeSync(fd);closeSync(parent);}
}

/** Records the edit's result next to the backups and returns the ledger. */
export function completeLedger(s: Snapshot): Ledger {
  const after=s.files.map(f=>{const bytes=safeRead(f.path);assertBackupSafe(f.path,bytes);return bytes;});
  const files = s.files.map((f, i) => {
    const bytes = after[i]!;
    if (bytes === null) return { ...f, after: null };
    const copy = join(s.dir, 'after', `${i}-${f.path.split('/').at(-1)}`);
    writeBackup(copy,bytes);
    return { ...f, after: copy };
  });
  const before = new Set(s.listing);
  const tracked = new Set(s.files.map((f) => f.path));
  const created = list(s.watch).filter((p) => !before.has(p) && !tracked.has(p));
  const owned = (path: string) => s.namespaced.some(n => path === n.path || path.startsWith(`${n.path}/`));
  const ledger: Ledger = {
    version: 1,
    kind: s.kind,
    at: s.at,
    dir: s.dir,
    files,
    createdFiles: created.filter((p) => owned(p) && !p.endsWith('/')).map((path) => ({ path, sha: sha(safeRead(path) ?? Buffer.alloc(0)) })),
    // Only namespaced directories are owned; remove them only when empty.
    createdDirs: created.filter((p) => owned(p) && p.endsWith('/')).map((p) => p.slice(0, -1)),
    retainedPaths: created.filter(p => !owned(p)),
    namespaced: s.namespaced,
    extra: s.extra,
  };
  safeWrite(join(s.dir, 'ledger.json'), `${JSON.stringify(ledger, null, 2)}\n`);
  return ledger;
}

export interface LedgerPolicy { backupRoot: string; files: string[]; namespaced: string[]; alternativeFiles?: string[][] }
export function readLedger(dir: string, policy: LedgerPolicy): Ledger {
  const within = (root: string, path: unknown): path is string => typeof path === 'string' && isAbsolute(path) && path === resolve(path) && !!relative(root,path) && relative(root,path) !== '..' && !relative(root,path).startsWith('..'+sep) && !isAbsolute(relative(root,path));
  const root = resolve(policy.backupRoot);
  if (!within(root, dir) || dirname(dir) !== root) throw new Error('ledger directory is outside the confined backup root');
  closeSync(openPrivateDirectory(root)!); closeSync(openPrivateDirectory(dir)!);
  const bytes = safeRead(join(dir,'ledger.json'));
  if (!bytes) throw new Error('missing confined ledger');
  const l = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)) as Ledger;
  const backup = (path: unknown) => path === null || (within(dir,path) && ['before','after','before-md','after-md'].includes(dirname(path).split(sep).at(-1)!) && dirname(dirname(path)) === dir);
  const owned = (path: unknown): path is string => typeof path === 'string' && policy.namespaced.some(n => path === n || within(n,path));
  if (l.version !== 1 || l.dir !== dir || !Array.isArray(l.files) || ![policy.files,...(policy.alternativeFiles??[])].some(paths=>l.files.length===paths.length && l.files.every((f,i)=>f.path===paths[i] && backup(f.before) && backup(f.after))) || !Array.isArray(l.namespaced) || l.namespaced.length !== policy.namespaced.length || !l.namespaced.every((n,i) => n.path === policy.namespaced[i] && typeof n.existed === 'boolean') || !Array.isArray(l.createdFiles) || !l.createdFiles.every(f => owned(f.path) && /^[a-f0-9]{64}$/.test(f.sha)) || !Array.isArray(l.createdDirs) || !l.createdDirs.every(owned)) throw new Error('ledger paths or schema violate confinement policy');
  // Validate all referenced paths before any restore or namespace removal can occur.
  for (const f of l.files) for (const p of [f.before,f.after]) if (p !== null) { checkComponents(p); closeSync(openPrivateDirectory(dirname(p))!); }
  for (const p of [...l.files.map(f=>f.path),...l.namespaced.map(n=>n.path),...l.createdDirs,...l.createdFiles.map(f=>f.path)]) checkComponents(p);
  return l;
}

/** Reverse known managed fields; preserve concurrent changes without post-edit ownership proof. */
export function rollbackSnapshot(s: Snapshot, rules: Record<string, Rule>): string[] {
  const before = new Set(s.listing);
  const l: Ledger = { ...s, files: s.files.map(f => ({ ...f, after: f.before })), createdFiles: [], createdDirs: [] };
  const unchanged = assess(l, rules);
  revert(l, rules, unchanged);
  const owned = (path: string) => s.namespaced.some(n => path === n.path || path.startsWith(`${n.path}/`));
  for (const path of list(s.watch).filter(p => !before.has(p) && p.endsWith('/') && owned(p)).sort((a, b) => b.length - a.length)) {
    try { rmdirSync(path.slice(0, -1)); } catch { /* Retain nonempty/unavailable paths. */ }
  }
  // Only tracked config and newly created namespaced artifacts are provably ours. Other paths
  // may belong to a concurrent plugin install or backup, so retain them without reading them.
  return list(s.watch).filter(p => !before.has(p));
}

/** Per file: true when nothing but our own entries changed since the edit. Call after runner removal commands. */
export function assess(l: Ledger, rules: Record<string, Rule>): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const f of l.files) {
    out[f.path] = unchangedBytes(f, rules[f.path], safeRead(f.path));
  }
  return out;
}

function unchangedBytes(f: Ledger['files'][number], rule: Rule | undefined, bytes: Buffer | null): boolean {
    if (!rule) {
      const after = f.after ? safeRead(f.after) : null;
      return after === null ? bytes === null : bytes !== null && after.equals(bytes);
    }
    const before = f.before ? readText(f.before) : null;
    const after = f.after ? readText(f.after) : null;
    const now = bytes?.toString('utf8') ?? null;
    const form = (t: string | null) => {
      if (t === null) return '\u0000absent';
      const stripped = rule.strip(t, before);
      return before === null && stripped !== t && rule.empty?.(stripped) ? '\u0000absent' : rule.canon(stripped);
    };
    // A concurrent edit during installation is already present in `after`.
    // Byte restoration is safe only when unmanaged content also matches the original.
    return form(now) === form(after) && form(after) === form(before);
}

/** Puts files back (see the module comment) and cleans up what the edit created. */
export function revert(l: Ledger, rules: Record<string, Rule>, unchanged: Record<string, boolean>): FileReport[] {
  for(const n of l.namespaced)checkComponents(n.path);
  // Recheck all current config before any restoration/reverse edit creates a copy.
  const current = new Map(l.files.map(f => { const bytes = safeRead(f.path); assertBackupSafe(f.path, bytes); return [f.path, bytes] as const; }));
  const reports: FileReport[] = [];
  for (const f of l.files) {
    const before = f.before ? safeRead(f.before) : null;
    if (unchanged[f.path] && unchangedBytes(f, rules[f.path], current.get(f.path)!)) {
      if (before) {
        mkdirSync(dirname(f.path), { recursive: true });
        safeWrite(f.path, before,current.get(f.path)!);
        reports.push({ path: f.path, outcome: 'restored' });
      } else {
        safeRemove(f.path, current.get(f.path)!);
        reports.push({ path: f.path, outcome: 'deleted' });
      }
      continue;
    }
    const now = current.get(f.path)?.toString('utf8') ?? null;
    if (now === null) {
      reports.push({ path: f.path, outcome: 'missing', backup: f.before ?? undefined });
      continue;
    }
    const rule = rules[f.path];
    const stripped = rule ? rule.strip(now, before?.toString('utf8') ?? null) : now;
    if (stripped !== now) safeWrite(f.path, stripped,current.get(f.path)!);
    reports.push({ path: f.path, outcome: 'reverse-edited', backup: f.before ?? undefined });
  }
  for (const n of l.namespaced) if (!n.existed) safeRemoveTree(n.path);
  for (const c of l.createdFiles) {
    const bytes = safeRead(c.path);
    if (bytes && sha(bytes) === c.sha) unlinkSync(c.path);
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
