import { anchor, childTarget } from '../core/platform.ts';
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
import { existsSync, lstatSync, mkdirPrivateSync, opendirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from '../core/platform.ts';
import { basename, dirname, join, resolve, relative, isAbsolute, sep } from 'node:path';
import { closeSync, fstatSync, fsyncSync, openSync } from '../core/platform.ts';
import { openPrivateDirectory } from '../core/store.ts';
import { candidateDigest, checkComponents, checkOwnedDirectory, checkOwnedFile, safeRead, safeRemove, safeRemoveEmptyDirectory, safeRemoveTree, safeWrite } from './files.ts';
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
  /** `before-missing` and `after-missing`: a backup copy is gone, so only our entries were removed. */
  outcome: 'restored' | 'deleted' | 'reverse-edited' | 'unchanged' | 'missing' | 'before-missing' | 'after-missing';
  /** Where the original bytes are kept, for a reverse edit. */
  backup?: string;
  /** The backup copy that is gone. */
  lost?: string;
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

/** Reuse root/file ownership checks before install and uninstall runner commands. */
export function preflightOwnership(opts: {files:string[];watch:string[];namespaced:string[]}): void {
  for (const path of opts.watch) {
    checkComponents(path);
    try {if(!lstatSync(path).isDirectory())throw new Error(`setup watched root is not a directory: ${path}`);}
    catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
    checkOwnedDirectory(path);
  }
  for(const path of opts.namespaced)checkComponents(path);
  // An interrupted write explains a tracked file that is missing or has two links, so its leftovers are named first.
  for(const path of opts.files)checkComponents(path);
  refuseInterruptedWrites(opts.files);
  for(const path of opts.files)checkOwnedFile(path);
}

/** A write or deletion killed midway leaves setup files beside tracked files. The refusal names every one. */
function refuseInterruptedWrites(files: string[]): void {
  for (const dir of new Set(files.map((path) => dirname(path)))) {
    let directory;
    try { directory = opendirSync(dir); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; throw e; }
    const steps: string[] = [];
    try {
      for (let entry; (entry = directory.readSync()) !== null;) {
        const left = join(dir, entry.name);
        if (/^\.context-engine-setup-[0-9a-f]{16}\.tmp$/.test(entry.name)) { steps.push(`Remove ${left}. Setup writes there first, and it never holds the only copy of a file.`); continue; }
        const candidate = /^\.context-engine-(?:replace|delete)-[0-9a-f]{32}(?:-([0-9a-f]{16}))?\.tmp$/.exec(entry.name);
        if (!candidate) continue;
        // The name's digest says which tracked file the candidate came from. Whether that file exists says what to do.
        const target = files.find((path) => dirname(path) === dir && candidate[1] === candidateDigest(path));
        if (target === undefined) steps.push(`${left} may hold the only current bytes of a tracked file in ${dir}. Move it back to that file's name if that file is missing, or remove it.`);
        else if (present(target)) steps.push(`Remove ${left}. ${target} exists, and the candidate holds only its earlier bytes or nothing.`);
        else steps.push(`Move ${left} back to ${target}. It holds the only current bytes of that file.`);
      }
    } finally { directory.closeSync(); }
    if (steps.length) throw new Error(`an interrupted setup write left files beside tracked configuration. ${steps.join(' ')} Then run setup again.`);
  }
}

function present(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; }
}

/** Backs up `files` byte for byte into a new timestamped dir under `backupRoot`, and lists `watch`. */
export function takeSnapshot(opts: { backupRoot: string; kind: string; files: string[]; watch: string[]; namespaced: string[]; extra?: Record<string, unknown> }): Snapshot {
  preflightOwnership(opts);
  const before=opts.files.map(path=>{const bytes=safeRead(path);assertBackupSafe(path,bytes);return bytes;});
  const listing = list(opts.watch);
  const namespaced = opts.namespaced.map(path => ({ path, existed: existsSync(path) }));
  const at = new Date();
  const copies: Array<{ path: string; bytes: Buffer }> = [];
  const directories: string[] = [];
  let dir: string | undefined;
  try {
    checkComponents(opts.backupRoot);
    const parent = openPrivateDirectory(opts.backupRoot, { create: true })!;
    try {
      for (let n = 1;; n++) {
        const name = `${opts.kind}-${timestamp(at)}${n === 1 ? '' : '-' + n}`;
        if (name.includes('/') || name.includes('\\') || name === '..') throw new Error('invalid snapshot kind');
        const candidate = join(opts.backupRoot, name);
        try { mkdirPrivateSync(childTarget(anchor(parent), name)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue; throw error; }
        dir = candidate;
        directories.push(dir);
        fsyncSync(parent);
        break;
      }
    } finally { closeSync(parent); }
    for (const category of ['before', 'after']) {
      const path = join(dir, category);
      directories.push(path);
      closeSync(openPrivateDirectory(path, { create: true })!);
    }
    const files = opts.files.map((path, i) => {
      const copy = join(dir!, 'before', `${i}-${path.split('/').at(-1)}`);
      const bytes = before[i]!;
      if (bytes === null) return { path, before: null, after: null };
      writeBackup(copy, bytes);
      copies.push({ path: copy, bytes });
      return { path, before: copy, after: null };
    });
    return { version: 1, kind: opts.kind, at: at.toISOString(), dir, files, namespaced,
      extra: opts.extra ?? {}, watch: opts.watch, listing };
  } catch (error) {
    try {
      for (const copy of copies.reverse()) safeRemove(copy.path, copy.bytes);
      for (const path of directories.reverse()) {
        if (existsSync(path)) safeRemoveEmptyDirectory(path);
      }
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], `snapshot creation failed and cleanup is incomplete at ${dir ?? opts.backupRoot}`);
    }
    throw error;
  }
}

/** Exclusive backup writes through the verified private parent; planted copies are never followed. */
function writeBackup(path: string, bytes: Buffer): void {
  const parent = openPrivateDirectory(dirname(path))!;
  let fd: number | undefined;
  try {
    fd = openSync(childTarget(anchor(parent),path.split('/').at(-1)!),'exclusive-nofollow');
    writeFileSync(fd,bytes); fsyncSync(fd); fsyncSync(parent);
  } catch (error) {
    if (fd !== undefined) {
      try {
        const target = childTarget(anchor(parent), path.split('/').at(-1)!);
        const opened = fstatSync(fd), current = lstatSync(target);
        if (opened.dev !== current.dev || opened.ino !== current.ino || current.nlink !== 1) throw new Error('incomplete snapshot copy was replaced; retained');
        unlinkSync(target);
        fsyncSync(parent);
      } catch (cleanup) { throw new AggregateError([error, cleanup], `snapshot copy failed and cleanup is incomplete at ${path}`); }
    }
    throw error;
  } finally {if(fd!==undefined)closeSync(fd);closeSync(parent);}
}

/** Discard only successful publication rollback copies; retain unexpected entries. */
export function discardSnapshot(s: Snapshot): void {
  for(const f of s.files)if(f.before){
    if(dirname(f.before)!==join(s.dir,'before'))throw new Error('rollback snapshot copy outside its directory');
    safeRemove(f.before,safeRead(f.before));
  }
  const parent=openPrivateDirectory(dirname(s.dir))!;
  let directory:number|undefined;
  try {
    directory=openPrivateDirectory(s.dir)!;
    for(const name of ['before','after'])rmdirSync(childTarget(anchor(directory),name));
    fsyncSync(directory);
    const target=childTarget(anchor(parent),basename(s.dir)),now=lstatSync(target),opened=lstatSync(childTarget(anchor(directory), '.'));
    if(now.dev!==opened.dev||now.ino!==opened.ino)throw new Error('rollback snapshot directory changed; retained');
    rmdirSync(target);fsyncSync(parent);
  }finally{if(directory!==undefined)closeSync(directory);closeSync(parent);}
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
    createdFiles: created.filter((p) => owned(p) && !p.endsWith('/')).flatMap(path => {
      const bytes = safeRead(path);
      return bytes === null ? [] : [{ path, sha: sha(bytes) }];
    }),
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
  // Validate all referenced paths before any restore or namespace removal can occur. Copies are not read
  // here: status and enable need none, and revert handles a copy that is gone.
  for (const f of l.files) for (const p of [f.before,f.after]) if (p !== null) {
    checkComponents(p);
    const parent = openPrivateDirectory(dirname(p));
    if (parent !== undefined) closeSync(parent);
  }
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
    try { safeRemoveEmptyDirectory(path.slice(0, -1)); } catch { /* Retain nonempty/unavailable paths. */ }
  }
  // Only tracked config and newly created namespaced artifacts are provably ours. Other paths
  // may belong to a concurrent plugin install or backup, so retain them without reading them.
  return list(s.watch).filter(p => !before.has(p));
}

/** Per file: true when nothing but our own entries changed since the edit. Call after runner removal commands. */
export function assess(l: Ledger, rules: Record<string, Rule>): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const f of l.files) {
    out[f.path] = about(f.path, () => unchangedBytes(f, rules[f.path], safeRead(f.path)));
  }
  return out;
}

/** A rule's parse error names the file it came from. */
function about<T>(path: string, action: () => T): T {
  try { return action(); }
  catch (e) {
    if (e instanceof Error && !e.message.includes(path)) e.message = `${path}: ${e.message}`;
    throw e;
  }
}

/** The first backup copy of `f` that the ledger names but that is gone. */
function lostCopy(f: Ledger['files'][number]): { kind: 'before' | 'after'; path: string } | undefined {
  if (f.before !== null && safeRead(f.before) === null) return { kind: 'before', path: f.before };
  if (f.after !== null && safeRead(f.after) === null) return { kind: 'after', path: f.after };
  return undefined;
}

function unchangedBytes(f: Ledger['files'][number], rule: Rule | undefined, bytes: Buffer | null): boolean {
    // A copy that is gone proves nothing. Read as an absent file, it would let revert delete a live one.
    if (lostCopy(f)) return false;
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
    // A file whose copy is gone is never restored or deleted. It gets the reverse edit, and the report names the copy.
    const lost = lostCopy(f);
    if (!lost && unchanged[f.path] && about(f.path, () => unchangedBytes(f, rules[f.path], current.get(f.path)!))) {
      if (before) {
        safeWrite(f.path, before,current.get(f.path)!);
        reports.push({ path: f.path, outcome: 'restored' });
      } else {
        safeRemove(f.path, current.get(f.path)!);
        reports.push({ path: f.path, outcome: 'deleted' });
      }
      continue;
    }
    const now = current.get(f.path)?.toString('utf8') ?? null;
    const backup = before ? f.before! : undefined;
    if (now === null) {
      reports.push({ path: f.path, outcome: 'missing', backup });
      continue;
    }
    const rule = rules[f.path];
    const stripped = rule ? about(f.path, () => rule.strip(now, before?.toString('utf8') ?? null)) : now;
    if (stripped !== now) safeWrite(f.path, stripped,current.get(f.path)!);
    reports.push(lost ? { path: f.path, outcome: `${lost.kind}-missing`, backup, lost: lost.path } : { path: f.path, outcome: 'reverse-edited', backup });
  }
  for (const n of l.namespaced) if (!n.existed) safeRemoveTree(n.path);
  for (const c of l.createdFiles) {
    const bytes = safeRead(c.path);
    if (bytes && sha(bytes) === c.sha) safeRemove(c.path,bytes);
  }
  for (const d of [...l.createdDirs].sort((a, b) => b.length - a.length)) {
    try {
      safeRemoveEmptyDirectory(d);
    } catch {
      // Not empty (someone else uses it now) or already gone: leave it.
    }
  }
  return reports;
}
