// Setup operates on tracked runner configuration; backups have a separate key-based gate. Descriptor checks keep reads and replacements
// anchored to the verified directory even if a project changes a path concurrently. Linux /proc
// is required, like the core's confined file reads.
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { openPrivateDirectory } from '../core/store.ts';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join, parse, resolve, sep } from 'node:path';

export function checkComponents(path: string): void {
  const absolute = resolve(path);
  let current = parse(absolute).root;
  for (const part of absolute.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      const st = lstatSync(current);
      if (st.isSymbolicLink()) throw new Error(`setup refuses linked path: ${current}`);
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }
}

export function safeRead(path: string): Buffer | null {
  checkComponents(path);
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || realpathSync(`/proc/self/fd/${fd}`) !== resolve(path)) throw new Error(`setup refuses unverified or linked file: ${path}`);
    return readFileSync(fd);
  } finally { closeSync(fd); }
}

export function safeWrite(path: string, data: string | Buffer): void {
  checkComponents(path);
  const parent = dirname(resolve(path));
  mkdirSync(parent, { recursive: true });
  checkComponents(path);
  if (existsSync(path)) {
    const st = lstatSync(path);
    if (!st.isFile() || st.nlink !== 1) throw new Error(`setup refuses linked or nonregular file: ${path}`);
  }
  const fd = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  let tmp: string | undefined;
  try {
    if (!fstatSync(fd).isDirectory() || realpathSync(`/proc/self/fd/${fd}`) !== parent) throw new Error(`setup cannot verify directory: ${parent}`);
    const anchored = `/proc/self/fd/${fd}`;
    tmp = join(anchored, `.context-engine-setup-${randomBytes(8).toString('hex')}.tmp`);
    writeFileSync(tmp, data, { flag: 'wx', mode: 0o600 });
    renameSync(tmp, join(anchored, basename(path)));
  } finally {
    if (tmp) try { unlinkSync(tmp); } catch {}
    closeSync(fd);
  }
}

/** One runner-wide lease, held until synchronous or asynchronous setup work has finished. */
export function acquireSetupLock(path: string): () => void {
  checkComponents(path);
  const parent = dirname(resolve(path));
  closeSync(openPrivateDirectory(dirname(parent), { create: true })!);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  checkComponents(path);
  const dir = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  let lock: number | undefined;
  let released = false;
  const anchored = join(`/proc/self/fd/${dir}`, basename(path));
  const release = () => {
    if (released) return;
    released = true;
    try {
      if (lock !== undefined) {
        try {
          const own = fstatSync(lock), now = lstatSync(anchored);
          if (own.dev === now.dev && own.ino === now.ino) unlinkSync(anchored);
        } finally { closeSync(lock); }
      }
    } finally { closeSync(dir); }
  };
  try {
    if (!fstatSync(dir).isDirectory() || realpathSync(`/proc/self/fd/${dir}`) !== parent) throw new Error(`setup cannot verify directory: ${parent}`);
    try { lock = openSync(anchored, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`setup transaction already locked: ${path}; wait for the active setup to finish. If interrupted, verify no setup process is running before removing this lock.`);
      throw e;
    }
    writeFileSync(lock, `${JSON.stringify({ pid: process.pid })}\n`);
    return release;
  } catch (e) { release(); throw e; }
}

export function withSetupLock<T>(path: string, action: () => T): T {
  const release = acquireSetupLock(path);
  try { return action(); } finally { release(); }
}
