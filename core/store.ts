// File primitives and layout for the core. Every write is temp + fsync + rename, so a reader
// sees the old file or the new one, never a torn one.
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fchmodSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  ftruncateSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { confineStep, crashPoint, fdLinkPath, type CrashPoint } from './faults.ts';
import { serialized } from './lock.ts';

export const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function assertSessionId(id: string): void {
  if (!SESSION_ID.test(id)) throw new Error(`invalid session id ${JSON.stringify(id)}: use letters, digits, '.', '_' or '-' (max 128)`);
}

/** State root: explicit option, then $CONTEXT_ENGINE_STATE_DIR, then $XDG_STATE_HOME/context-engine. */
export function resolveStateRoot(explicit?: string, environment: NodeJS.ProcessEnv = process.env): string {
  if (explicit) {
    if (!isAbsolute(explicit)) throw new Error('Context Engine state root must be absolute');
    return explicit;
  }
  const env = environment.CONTEXT_ENGINE_STATE_DIR;
  if (env) {
    if (!isAbsolute(env)) throw new Error('CONTEXT_ENGINE_STATE_DIR must be absolute');
    return env;
  }
  const xdg = environment.XDG_STATE_HOME;
  return join(xdg && isAbsolute(xdg) ? xdg : join(environment.HOME || homedir(), '.local', 'state'), 'context-engine');
}

/** `<basename>-<sha256(realpath)>`: readable, with collision-resistant project isolation. */
export function projectKey(projectRoot: string): string {
  const real = realpathSync(projectRoot);
  // Preserve every previously valid state-directory key (255-byte component).
  // Only longer, previously unusable names need a shorter readable prefix.
  const raw = basename(real).replace(/[^\w.-]/g, '_') || 'root';
  const name = raw.length <= 190 ? raw : raw.slice(0, 128);
  return `${name}-${sha(real)}`;
}

/** The workspace directory that holds every session's Working Context (self-gitignored). */
export const WORKING_CONTEXT_DIR = '.context-engine';

/**
 * The Working Context's path relative to the project root: `.context-engine/<session>/context.md`.
 * The id is not validated here, so adapters can fill in a placeholder such as `$CODEX_THREAD_ID`
 * for text the model's shell expands; `layout` validates real ids.
 */
export function workingContextRelPath(sessionId: string): string {
  return `${WORKING_CONTEXT_DIR}/${sessionId}/context.md`;
}

/** The Working Context's absolute path for a real session id (validated). */
export function workingContextPath(projectRoot: string, sessionId: string): string {
  assertSessionId(sessionId);
  return join(realpathSync(projectRoot), workingContextRelPath(sessionId));
}

export interface Layout {
  workingContext: string;
  stateDir: string;
  head: string;
  revisions: string;
  events: string;
  lock: string;
}

export function layout(projectRoot: string, sessionId: string, stateRoot: string): Layout {
  assertSessionId(sessionId);
  const real = realpathSync(projectRoot);
  const stateDir = join(stateRoot, projectKey(real), sessionId);
  return {
    workingContext: join(real, workingContextRelPath(sessionId)),
    stateDir,
    head: join(stateDir, 'HEAD'),
    revisions: join(stateDir, 'revisions'),
    events: join(stateDir, 'events.jsonl'),
    lock: join(stateDir, 'lock'),
  };
}

/** Opens one verified user-owned private directory. Only managed Working Context directories may be tightened. */
export function openPrivateDirectory(path: string, opts: { create?: boolean; tighten?: boolean } = {}): number | undefined {
  if (opts.create) createConfinedDirectory(path);
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); }
  catch (e) { if (!opts.create && (e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw new Error(`refusing linked or unavailable private directory: ${path}`, { cause: e }); }
  try {
    const st = fstatSync(fd);
    if (!st.isDirectory() || openedPath(fd) !== resolve(path) || (process.getuid && st.uid !== process.getuid())) throw new Error(`private directory is not verified or owned by this user: ${path}`);
    if (opts.tighten) fchmodSync(fd, 0o700);
    else if ((st.mode & 0o077) !== 0) throw new Error(`state directory must already be private (0700): ${path}`);
    return fd;
  } catch (e) { closeSync(fd); throw e; }
}

/** Create missing components through verified descriptors, never through linked ancestors. */
function createConfinedDirectory(path: string, ownedFrom?: string): void {
  const target = resolve(path);
  const missing: string[] = [];
  let existing = target;
  for (;;) {
    try { lstatSync(existing); break; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    missing.unshift(basename(existing));
    existing = dirname(existing);
  }
  let fd: number;
  try { fd = openSync(existing, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); }
  catch (e) { throw new Error('linked or unavailable private-directory ancestor; refusing creation', { cause: e }); }
  try {
    if (openedPath(fd) !== existing) throw new Error('linked private-directory ancestor; refusing creation');
    const checkOwner = () => {
      if (ownedFrom && isWithin(ownedFrom, existing) && process.getuid && fstatSync(fd).uid !== process.getuid()) throw new Error('managed directory is not owned by this user; refusing creation');
    };
    checkOwner();
    for (const name of missing) {
      checkOwner();
      if (openedPath(fd) !== existing) throw new Error('private-directory ancestor changed; refusing creation');
      const anchored = join(`/proc/self/fd/${fd}`, name);
      try { mkdirSync(anchored, { mode: 0o700 }); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
      const next = openSync(anchored, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      closeSync(fd); fd = next;
      existing = join(existing, name);
      if (openedPath(fd) !== existing) throw new Error('private-directory child changed; refusing creation');
      checkOwner();
    }
  } finally { closeSync(fd); }
}

function privateWorkingContextFile(path: string): void {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (e) { if (['ENOENT', 'ELOOP'].includes((e as NodeJS.ErrnoException).code ?? '')) return; throw e; }
  try {
    const st = fstatSync(fd), real = openedPath(fd);
    if (real !== path) throw new Error('Working Context file path changed; refusing permission changes');
    if (!st.isFile() || st.nlink !== 1 || isCredential(real, st)) return;
    if (process.getuid && st.uid !== process.getuid()) throw new Error('Working Context file is not owned by this user');
    fchmodSync(fd, 0o600);
  } finally { closeSync(fd); }
}

/** Creates the private state directories (mode 0700) and the Working Context directory. */
export function ensureDirs(l: Layout, stateRoot: string): void {
  for (const d of [stateRoot, dirname(l.stateDir), l.stateDir, l.revisions]) {
    closeSync(openPrivateDirectory(d, { create: true })!);
  }
  assertWorkingContextDir(l.workingContext);
  createConfinedDirectory(dirname(l.workingContext), dirname(dirname(l.workingContext)));
  assertWorkingContextDir(l.workingContext);
  // Self-ignoring directory: keeps Working Contexts out of git without editing the project's .gitignore.
  const managed = dirname(dirname(l.workingContext));
  const parent = openPrivateDirectory(managed, { tighten: true })!;
  try {
  const ignore = join(fdLinkPath(parent), '.gitignore');
  try {
    // O_EXCL does not follow even a dangling symlink at this name.
    writeFileSync(ignore, '# Context Engine Working Contexts are never committed.\n*\n', { flag: 'wx' });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    const existing = readWorkingContextFile(join(managed, '.gitignore'));
    if (!Buffer.isBuffer(existing)) throw new Error('.context-engine/.gitignore must be a regular, unlinked file');
    const rules = existing.toString('utf8').split(/\r?\n/).map(v => v.trim()).filter(v => v && !v.startsWith('#'));
    if (rules.at(-1) !== '*') throw new Error('.context-engine/.gitignore must end with a blanket * rule; fix it before enabling Context Engine');
  }
  for (const dir of [dirname(dirname(l.workingContext)), dirname(l.workingContext)]) closeSync(openPrivateDirectory(dir, { tighten: true })!);
  privateWorkingContextFile(l.workingContext);
  } finally { closeSync(parent); }
}

const FRAME_KEY = /^[0-9a-f]{32}$/;

/** The frame key stored at `path`, or null when there is none or it is not a whole key. */
function storedFrameKey(path: string): string | null {
  try {
    const text = readBytes(path,33)?.toString('utf8').trim();
    return text && FRAME_KEY.test(text) ? text : null;
  } catch(e) { if((e as NodeJS.ErrnoException).code==='CE_SIZE_LIMIT')return null;throw e; }
}

/**
 * The session's frame key (see Session.frameKey): made on first use, then read back. A new key is
 * written whole and fsynced under the core's own temp name, then published with link(2), which
 * fails if anything is already there: a crash leaves at most a temp file (removed by recovery),
 * never a torn key. If something is there, a whole key stands (another writer won); anything else
 * (empty or partial, from an interrupted create by an older core) is replaced atomically by rename.
 * Called while the session is held (openSession), so no other opener races the replacement.
 */
export function sessionFrameKey(stateDir: string): string {
  const parent = openPrivateDirectory(stateDir)!;
  const path = join(stateDir, 'frame-key'), target = join(fdLinkPath(parent),'frame-key');
  let tmp: string | undefined;
  try {
  const existing = storedFrameKey(path);
  if (existing) return existing;
  const key = randomBytes(16).toString('hex');
  tmp = writeTemp(target, `${key}\n`, 'frame-key-tmp', 0o600);
  try {
    try {
      linkSync(tmp, target); fsyncSync(parent);
      return key;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    const theirs = storedFrameKey(path);
    if (theirs) return theirs;
    renameSync(tmp, target); fsyncSync(parent);
    return key;
  } finally {
    try {
      unlinkSync(tmp);
    } catch {}
  }
  } finally { closeSync(parent); }
}

// ---- confinement: symlinks, hard links, credential files ----

const isWithin = (root: string, p: string) => p === root || p.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);

function realOrResolved(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/**
 * Credential files and directories the core never reads, whatever path leads to them: the runners'
 * subscription credentials and the usual key stores. Files are matched by real path and by inode
 * (a hard link has another path); directories by real path.
 */
function credentialTargets(): { files: string[]; dirs: string[] } {
  const home = homedir();
  const files = [
    join(home, '.codex', 'auth.json'),
    join(home, '.claude', '.credentials.json'),
    join(home, '.netrc'),
    join(home, '.git-credentials'),
    join(home, '.config', 'gh', 'hosts.yml'),
    join(home, '.docker', 'config.json'),
  ];
  if (process.env.CODEX_HOME) files.push(join(process.env.CODEX_HOME, 'auth.json'));
  if (process.env.CLAUDE_CONFIG_DIR) files.push(join(process.env.CLAUDE_CONFIG_DIR, '.credentials.json'));
  return { files, dirs: ['.ssh', '.gnupg', '.aws'].map((d) => join(home, d)) };
}

/**
 * True when the opened file (its kernel-reported path `real` and its fstat identity `st`) is a
 * credential file, a hard link to one (same dev+ino), or lies in a key-store directory. The
 * identity comes from the open descriptor, so nothing can be swapped between this check and the read.
 */
function isCredential(real: string, st: { dev: number; ino: number }): boolean {
  // Project-local secret stores are just as sensitive as their home equivalents.
  // Classify by known location before reading any bytes, never inspect secrets.
  const parts = real.split(sep), name = parts.at(-1) ?? '';
  if (parts.some(p => ['.ssh', '.gnupg', '.aws'].includes(p))) return true;
  if (name === '.env' || name.startsWith('.env.') || ['.npmrc', '.pypirc', '.netrc', '.git-credentials', 'id_rsa', 'id_ed25519'].includes(name) || /\.(?:pem|p12|pfx|key)$/.test(name)) return true;
  if ((parts.at(-2) === '.codex' && name === 'auth.json') || (parts.at(-2) === '.claude' && name === '.credentials.json') || (parts.at(-2) === '.docker' && name === 'config.json') || (parts.at(-2) === 'gh' && name === 'hosts.yml')) return true;
  const { files, dirs } = credentialTargets();
  for (const f of files) {
    if (realOrResolved(f) === real) return true;
    try {
      const c = statSync(f);
      if (c.dev === st.dev && c.ino === st.ino) return true;
    } catch {}
  }
  return dirs.some((d) => isWithin(realOrResolved(d), real));
}

/**
 * The real path of what `fd` actually is, from the kernel (`/proc/self/fd/<fd>`), not from the
 * name that was opened. PLATFORM ASSUMPTION: Linux with /proc mounted (the core already relies on
 * /proc for lock liveness). Where /proc is unavailable this throws, so every confined read fails
 * closed: nothing is read rather than read unverified.
 */
function openedPath(fd: number): string {
  try {
    return readlinkSync(fdLinkPath(fd));
  } catch (e) {
    throw new Error(`cannot verify which file was opened (${fdLinkPath(fd)} is unavailable: ${(e as NodeJS.ErrnoException).code ?? e}); refusing to read it. Confined reads need Linux with /proc mounted.`);
  }
}

/** Why a confined read refused: out of the project, a credential, or not one regular file with one name. */
export type Refusal = 'outside' | 'credential' | 'not-a-file';

/**
 * Reads `rel` inside `root`. Symlinks inside the project are resolved first, then the result is
 * opened with O_NOFOLLOW|O_NONBLOCK and every decision is made on the open descriptor: its real
 * path (from /proc, see openedPath) must stay inside the root's real path and must not be a
 * credential (by path or by dev+ino), and fstat must show a regular file with one link. The bytes
 * come from that same descriptor, so swapping the file or any directory above it after the checks
 * cannot change what is read. Throws ENOENT when the target does not exist, and fails closed
 * (throws) when the opened file cannot be identified.
 */
export function readConfined(root: string, rel: string): { bytes: Buffer } | { refused: Refusal } {
  const realRoot = realpathSync(root);
  const candidate = realpathSync(resolve(realRoot, rel));
  if (!isWithin(realRoot, candidate)) return { refused: 'outside' };
  confineStep('before-open', candidate);
  let fd: number;
  try {
    fd = openSync(candidate, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    // The checked name became a symbolic link: whatever it leads to is never followed.
    if ((e as NodeJS.ErrnoException).code === 'ELOOP') return { refused: 'not-a-file' };
    throw e;
  }
  try {
    const st = fstatSync(fd);
    const real = openedPath(fd);
    if (isCredential(real, st)) return { refused: 'credential' };
    if (!isWithin(realRoot, real)) return { refused: 'outside' };
    if (!st.isFile() || st.nlink !== 1) return { refused: 'not-a-file' };
    const bytes = boundedRead(fd, st.size, 16 * 1024 * 1024);
    if (bytes === 'too-large') throw new Error('cited source exceeds the 16 MiB size limit');
    return { bytes };
  } finally {
    closeSync(fd);
  }
}

function boundedRead(fd: number, size: number, maxBytes: number): Buffer | 'too-large' {
  if (size > maxBytes) return 'too-large';
  const chunk = Buffer.alloc(Math.min(65536, maxBytes + 1)), parts: Buffer[] = [];
  let total = 0;
  for (;;) {
    const n = readSync(fd, chunk, 0, Math.min(chunk.length, maxBytes + 1 - total), null);
    if (!n) return Buffer.concat(parts, total);
    total += n;
    if (total > maxBytes) return 'too-large';
    parts.push(Buffer.from(chunk.subarray(0, n)));
  }
}

/**
 * Throws unless the Working Context's directory is exactly where the layout puts it: no symbolic
 * link anywhere from the project's real root down to the session directory, so nothing the core
 * reads or writes there can land outside the project. A directory that does not exist yet is fine.
 */
export function assertWorkingContextDir(wc: string): void {
  // The nearest directory on the way that exists must be its own real path (`wc` is built from the
  // project's real path, so only links below the project root can make them differ).
  for (let dir = dirname(wc); ; dir = dirname(dir)) {
    let real: string;
    try {
      real = realpathSync(dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT' && dirname(dir) !== dir) continue;
      throw e;
    }
    if (real !== dir) throw new Error(`the Working Context directory ${dirname(wc)} passes through a symbolic link (${dir} -> ${real}); refusing to use it`);
    return;
  }
}

/**
 * Reads the Working Context file. Undefined when it does not exist; 'not-a-file' when it is a
 * symbolic link, a hard link (more than one name) or anything but a regular file: such a file is
 * never read, so a link cannot pull another file's contents (a credential, say) into the session.
 * Opened with O_NOFOLLOW and checked on the open descriptor, so the check and the read see the
 * same file: the kernel's path for the descriptor (see openedPath) must be exactly `wc`, so a
 * directory above it swapped for a link after assertWorkingContextDir is caught (thrown), and the
 * descriptor must not be a credential. Throws (fails closed) when /proc is unavailable.
 */
export function readWorkingContextFile(wc: string): Buffer | undefined | 'not-a-file';
export function readWorkingContextFile(wc: string, maxBytes: number): Buffer | undefined | 'not-a-file' | 'too-large';
export function readWorkingContextFile(wc: string, maxBytes?: number): Buffer | undefined | 'not-a-file' | 'too-large' {
  assertWorkingContextDir(wc);
  let fd: number;
  confineStep('before-open', wc);
  try {
    fd = openSync(wc, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return undefined;
    if (code === 'ELOOP') return 'not-a-file';
    throw e;
  }
  try {
    const st = fstatSync(fd);
    const real = openedPath(fd);
    if (real !== wc) throw new Error(`the Working Context's directory changed while it was being opened (${wc} led to ${real}); refusing to read it`);
    if (isCredential(real, st) || !st.isFile() || st.nlink !== 1) return 'not-a-file';
    if (maxBytes !== undefined) {
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error('invalid Working Context read bound');
      if (st.size > maxBytes) return 'too-large';
      const chunk = Buffer.alloc(Math.min(65536, maxBytes + 1)), parts: Buffer[] = [];
      let total = 0;
      for (;;) {
        const n = readSync(fd, chunk, 0, Math.min(chunk.length, maxBytes + 1 - total), null);
        if (!n) return Buffer.concat(parts, total);
        total += n;
        if (total > maxBytes) return 'too-large';
        parts.push(Buffer.from(chunk.subarray(0, n)));
      }
    }
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * The core's own temp-file names: `<file>.ce-<pid>-<8 hex>.tmp`, unique per write. Recovery removes
 * only these beside the Working Context, where the agent keeps files of its own.
 */
const CORE_TEMP = /\.ce-\d+-[0-9a-f]{8}\.tmp$/;

/** Writes `data` whole to a fresh temp file beside `path` (core naming) and fsyncs it. Returns its path. */
function writeTemp(path: string, data: string, point: CrashPoint, mode: number): string {
  const tmp = `${path}.ce-${process.pid}-${randomBytes(4).toString('hex')}.tmp`;
  // 'wx' (O_EXCL): a fresh file, never something already at that name (a symlink included).
  const fd = openSync(tmp, 'wx', mode);
  try {
    const bytes = Buffer.from(data);
    for (let offset = 0; offset < bytes.length;) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset);
      if (written <= 0) throw new Error('atomic write made no progress; refusing publication');
      offset += written;
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  crashPoint(point);
  return tmp;
}

export function atomicWrite(path: string, data: string, point: CrashPoint, mode = 0o600): void {
  if (point !== 'wc-tmp') {
    const parent = dirname(resolve(path));
    const fd = openPrivateDirectory(parent)!;
    let tmp: string | undefined;
    try {
      const target=join(fdLinkPath(fd),basename(path));
      tmp=writeTemp(target,data,point,mode);
      renameSync(tmp,target);
      fsyncSync(fd);
    } finally { if(tmp)try{unlinkSync(tmp);}catch{} closeSync(fd); }
    return;
  }
  // The editable workspace is not private state. Anchor both names to one
  // verified open directory, so a later parent swap cannot redirect a write.
  assertWorkingContextDir(path);
  const parent = dirname(path);
  const fd = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  let tmp: string | undefined;
  try {
    if (!fstatSync(fd).isDirectory() || openedPath(fd) !== parent) throw new Error('Working Context parent could not be verified; refusing to write');
    const target = join(fdLinkPath(fd), basename(path));
    tmp = writeTemp(target, data, point, mode);
    renameSync(tmp, target);
    fsyncSync(fd);
  } finally {
    if (tmp) try { unlinkSync(tmp); } catch {}
    closeSync(fd);
  }
}

export function readBytes(path: string, maxBytes?: number): Buffer | undefined {
  let fd: number;
  try { fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK); }
  catch(e) {if((e as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw e;}
  try {
    const st=fstatSync(fd),real=openedPath(fd);
    if(st.nlink!==1)throw Object.assign(new Error('private state file is linked under multiple names; refusing payload'),{code:'CE_STATE_LINK_COUNT'});
    if (!st.isFile() || real!==resolve(path) || isCredential(real,st) || (process.getuid&&st.uid!==process.getuid())) throw new Error('private state file is not verified, unlinked and user-owned');
    if(maxBytes!==undefined){const bytes=boundedRead(fd,st.size,maxBytes);if(bytes==='too-large')throw Object.assign(new Error('private state payload exceeds size limit'),{code:'CE_SIZE_LIMIT'});return bytes;}
    return readFileSync(fd);
  } finally {closeSync(fd);}
}

/** Appends one JSON line to the Event Log and fsyncs it. A torn tail is cut on recovery. */
export function appendLog(path: string, entry: Record<string, unknown>, opts: { timeoutMs?: number } = {}): void {
  serialized(`${path}.append.lock`, () => appendLogLocked(path, entry), opts);
}

function appendLogLocked(path: string, entry: Record<string, unknown>): void {
  truncateTornTailLocked(path);
  const line = Buffer.from(`${JSON.stringify({ ...entry, at: new Date().toISOString() })}\n`);
  const fd = verifiedLogDescriptor(path, true);
  try {
    try {
      crashPoint('log-torn');
    } catch (e) {
      writeSync(fd, line.subarray(0, line.length >> 1));
      throw e;
    }
    // The append lease prevents recall accounting or another writer from interleaving chunks.
    for (let offset = 0; offset < line.length;) {
      const written = writeSync(fd, line, offset, line.length - offset);
      if (written <= 0) throw Object.assign(new Error('incomplete Event Log append; state was not advanced'), { code: 'EIO' });
      offset += written;
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Reads every complete Event Log entry. A torn final line or a corrupt line is skipped. Memory follows the largest entry, not the complete history. */
export function* readLog(path: string): Generator<Record<string,unknown>> {
  let fd: number;
  try {fd=verifiedLogDescriptor(path,false,true);}
  catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}
  try {
    const chunk=Buffer.alloc(65536);
    let parts: Buffer[]=[],bytes=0;
    for(;;){
      const n=readSync(fd,chunk,0,chunk.length,null);if(!n)break;
      const batch=chunk.subarray(0,n);
      let start=0;
      while(start<n){
        const end=batch.indexOf(0x0a,start),stop=end<0?n:end,piece=batch.subarray(start,stop);
        bytes+=piece.length;
        parts.push(Buffer.from(piece));
        if(end<0)break;
        const line=Buffer.concat(parts,bytes).toString('utf8');parts=[];bytes=0;start=end+1;
        let entry: Record<string,unknown>;
        try {entry=JSON.parse(line) as Record<string,unknown>;}catch{continue;}
        if(validLogEntry(entry))yield entry;
      }
    }
    // Preserve the existing protocol: incomplete final lines are not records.
  } finally {closeSync(fd);}
}

/** Recognized structured payloads must be safe for recovery and evidence consumers. */
function validLogEntry(entry: unknown): entry is Record<string,unknown> {
  if(!entry || typeof entry!=='object' || Array.isArray(entry))return false;
  const row=entry as Record<string,unknown>;
  if(row.type!=='runner-events')return true;
  if(!Array.isArray(row.events))return false;
  let previous=0;
  for(const pending of row.events){
    if(!pending || typeof pending!=='object' || !Number.isSafeInteger(pending.seq) || pending.seq<=previous)return false;
    const event=pending.event;
    if(!event || typeof event!=='object' || Array.isArray(event) || typeof event.role!=='string' || typeof event.text!=='string')return false;
    previous=pending.seq;
  }
  if(row.replace!==undefined){const r=row.replace as Record<string,unknown>;if(!r || typeof r!=='object' || r.kind!=='native-compaction' || r.reason!=='over-budget' || typeof r.approxTokensBefore!=='number' || !Number.isFinite(r.approxTokensBefore) || r.approxTokensBefore<0 || (r.budgetTokens!==null && (typeof r.budgetTokens!=='number' || !Number.isFinite(r.budgetTokens) || r.budgetTokens<=0)))return false;}
  return true;
}

/** Cuts a torn (unterminated) final line off the Event Log. Returns the bytes removed. */
export function truncateTornTail(path: string): number {
  if (!existsSync(path)) return 0;
  return serialized(`${path}.append.lock`, () => truncateTornTailLocked(path));
}

function verifiedLogDescriptor(path: string, append: boolean, readOnly=false): number {
  const fd = openSync(path, (append ? constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT : readOnly ? constants.O_RDONLY : constants.O_RDWR) | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || openedPath(fd) !== resolve(path) || (process.getuid && st.uid !== process.getuid())) throw new Error('Event Log is not a verified unlinked owned regular file');
    return fd;
  } catch (e) { closeSync(fd); throw e; }
}

function truncateTornTailLocked(path: string): number {
  let fd: number;
  try { fd = verifiedLogDescriptor(path, false); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw e; }
  let size: number, keep = 0;
  try {
    size = fstatSync(fd).size;
    if (!size) return 0;
    const tail = Buffer.alloc(1);
    readSync(fd, tail, 0, 1, size - 1);
    if (tail[0] === 0x0a) return 0;
    // Scan only the unterminated suffix, not every historical payload.
    const block = Buffer.alloc(4096);
    for (let end = size; end > 0;) {
      const start = Math.max(0, end - block.length), length = end - start;
      readSync(fd, block, 0, length, start);
      const at = block.subarray(0, length).lastIndexOf(0x0a);
      if (at >= 0) { keep = start + at + 1; break; }
      end = start;
    }
    ftruncateSync(fd, keep);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  return size! - keep;
}

/**
 * Removes temp-file debris. In the session's private state directories (`privateDirs`) only the
 * core writes, so every `*.tmp` is its own (older versions named them `<file>.tmp`). Beside the
 * Working Context (`sharedDirs`) the agent keeps files of its own, so only names of the core's write
 * protocol (CORE_TEMP) are removed. Returns the removed paths.
 */
/** Remove selected regular entries through one verified parent, even if its name is replaced. */
export function removeDirectoryEntries(dir: string, own: (name: string) => boolean): string[] {
  const parent = openPrivateDirectory(dir);
  if (parent === undefined) return [];
  const removed: string[] = [];
  try {
    const anchored = fdLinkPath(parent);
    for (const name of readdirSync(anchored)) {
      if (!own(name)) continue;
      const target = join(anchored, name);
      try {
        const st = lstatSync(target);
        if (!st.isFile() || (process.getuid && st.uid !== process.getuid())) continue;
        unlinkSync(target);
        removed.push(join(dir, name));
      } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    }
    return removed;
  } finally { closeSync(parent); }
}

export function removeTemps(privateDirs: string[], sharedDirs: string[]): string[] {
  return [
    ...privateDirs.flatMap(dir => removeDirectoryEntries(dir, name => name.endsWith('.tmp'))),
    ...sharedDirs.flatMap(dir => removeDirectoryEntries(dir, name => CORE_TEMP.test(name))),
  ];
}
