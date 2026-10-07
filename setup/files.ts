// Setup operates on tracked runner configuration; backups have a separate key-based gate. Descriptor checks keep reads and replacements
// anchored to the verified directory even if a project changes a path concurrently. Linux /proc
// is required, like the core's confined file reads.
import { closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, opendirSync, readSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
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

export const SETUP_MAX_FILE_BYTES = 16 * 1024 * 1024;
function assertOwner(st: { uid: number }, path: string): void {
  if (!process.getuid || st.uid !== process.getuid()) throw new Error(`setup refuses foreign or unverifiable owner: ${path}`);
}

/** Verify an existing runner root before any configuration payload is read. */
export function checkOwnedDirectory(path: string): void {
  checkComponents(path);
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
  try {
    const st = fstatSync(fd); assertOwner(st, path);
    if (!st.isDirectory() || realpathSync(`/proc/self/fd/${fd}`) !== resolve(path)) throw new Error(`setup cannot verify directory: ${path}`);
  } finally { closeSync(fd); }
}

/** Check every tracked file before taking the first configuration payload backup. */
export function checkOwnedFile(path: string): void {
  checkComponents(path);
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch(e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
  try {
    const st = fstatSync(fd); assertOwner(st, path);
    if (!st.isFile() || st.nlink !== 1 || realpathSync(`/proc/self/fd/${fd}`) !== resolve(path)) throw new Error(`setup refuses unverified or linked file: ${path}`);
  } finally { closeSync(fd); }
}
/** Create missing setup parents through verified descriptors, without changing existing modes. */
function createParent(path: string): void {
  const missing: string[] = [];
  let current = resolve(path);
  for (;;) {
    try { lstatSync(current); break; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    missing.unshift(basename(current)); current = dirname(current);
  }
  let fd = openSync(current, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    for (const name of missing) {
      if (realpathSync(`/proc/self/fd/${fd}`) !== current) throw new Error('setup directory changed before creation');
      const anchored = join(`/proc/self/fd/${fd}`, name);
      try { mkdirSync(anchored, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
      const next = openSync(anchored, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { fsyncSync(fd); } catch (e) { closeSync(next); throw e; }
      closeSync(fd); fd = next; current = join(current, name);
    }
    if (realpathSync(`/proc/self/fd/${fd}`) !== current) throw new Error('setup cannot verify created directory');
  } finally { closeSync(fd); }
}
export function safeRead(path: string): Buffer | null {
  checkComponents(path);
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
  try {
    const st = fstatSync(fd);
    assertOwner(st, path);
    if (!st.isFile() || st.nlink !== 1 || realpathSync(`/proc/self/fd/${fd}`) !== resolve(path)) throw new Error(`setup refuses unverified or linked file: ${path}`);
    if (st.size > SETUP_MAX_FILE_BYTES) throw new Error('setup file exceeds the 16 MiB read limit');
    const parts: Buffer[] = [], chunk = Buffer.alloc(65536);
    let total = 0;
    for (;;) {
      const n = readSync(fd, chunk, 0, Math.min(chunk.length, SETUP_MAX_FILE_BYTES + 1 - total), null);
      if (!n) return Buffer.concat(parts, total);
      total += n;
      if (total > SETUP_MAX_FILE_BYTES) throw new Error('setup file exceeds the 16 MiB read limit');
      parts.push(Buffer.from(chunk.subarray(0, n)));
    }
  } finally { closeSync(fd); }
}

export function safeWrite(path: string, data: string | Buffer, expected?: Buffer | null): void {
  checkComponents(path);
  const parent = dirname(resolve(path));
  createParent(parent);
  checkComponents(path);
  if (existsSync(path)) {
    const st = lstatSync(path);
    assertOwner(st, path);
    if (!st.isFile() || st.nlink !== 1) throw new Error(`setup refuses linked or nonregular file: ${path}`);
  }
  const fd = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  let tmp: string | undefined;
  let candidate: string | undefined, moved = false;
  try {
    assertOwner(fstatSync(fd), parent);
    if (!fstatSync(fd).isDirectory() || realpathSync(`/proc/self/fd/${fd}`) !== parent) throw new Error(`setup cannot verify directory: ${parent}`);
    const anchored = `/proc/self/fd/${fd}`;
    tmp = join(anchored, `.context-engine-setup-${randomBytes(8).toString('hex')}.tmp`);
    const file = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(file, data); fsyncSync(file); } finally { closeSync(file); }
    const target=join(anchored,basename(path));
    if(expected===undefined)renameSync(tmp,target);
    else {
      if(expected!==null) {
        candidate=join(anchored,`.context-engine-replace-${randomBytes(16).toString('hex')}.tmp`);
        closeSync(openSync(candidate,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600));
        renameSync(target,candidate);moved=true;fsyncSync(fd);
        const old=openSync(candidate,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
        try {
          const st=fstatSync(old);assertOwner(st,path);
          if(!st.isFile()||st.nlink!==1||st.size!==expected.length||realpathSync(`/proc/self/fd/${old}`)!==join(realpathSync(anchored),basename(candidate)))throw new Error('setup file changed before replacement; retained');
          const bytes=Buffer.alloc(expected.length+1);let offset=0;
          for(;;){const n=readSync(old,bytes,offset,bytes.length-offset,offset);if(!n)break;offset+=n;if(offset===bytes.length)break;}
          if(offset!==expected.length||!bytes.subarray(0,offset).equals(expected))throw new Error('setup file changed before replacement; retained');
        } finally {closeSync(old);}
      }
      // Exclusive publication preserves a file created while the old destination was reserved.
      linkSync(tmp,target);unlinkSync(tmp);tmp=undefined;
      if(candidate){unlinkSync(candidate);candidate=undefined;moved=false;}
    }
    fsyncSync(fd);
  } catch(error) {
    if(candidate&&moved) {
      try {linkSync(candidate,join(`/proc/self/fd/${fd}`,basename(path)));unlinkSync(candidate);candidate=undefined;moved=false;fsyncSync(fd);}
      catch {throw new Error(`setup replacement refused; a newer destination was retained and the captured candidate remains at ${candidate}`,{cause:error});}
    }
    throw error;
  } finally {
    if (tmp) try { unlinkSync(tmp); } catch {}
    if(candidate&&!moved)try {unlinkSync(candidate);fsyncSync(fd);}catch{}
    closeSync(fd);
  }
}

/** Remove only a verified owned namespace, through open directories; never follow ancestry changes. */
export function safeRemoveTree(path: string): void {
  checkComponents(path);const parent=dirname(resolve(path));
  let parentFd:number;
  try {parentFd=openSync(parent,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);}
  catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}
  const budget={paths:0,bytes:0};
  const remove=(fd:number,expected:string,depth:number):void=>{
    assertOwner(fstatSync(fd),expected);
    if(depth>64||realpathSync(`/proc/self/fd/${fd}`)!==expected)throw new Error('setup namespace changed; retained');
    const dir=opendirSync(`/proc/self/fd/${fd}`);
    try {for(let entry;(entry=dir.readSync())!==null;){
      const absolute=join(expected,entry.name);budget.bytes+=Buffer.byteLength(absolute);if(++budget.paths>4096||budget.bytes>1048576)throw new Error('setup namespace cleanup exceeds inventory limits; retained');
      if(realpathSync(`/proc/self/fd/${fd}`)!==expected)throw new Error('setup namespace changed; retained');
      const target=join(`/proc/self/fd/${fd}`,entry.name),st=lstatSync(target);assertOwner(st,absolute);
      if(st.isDirectory()) {
        const child=openSync(target,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
        try {remove(child,absolute,depth+1);const now=lstatSync(target),opened=fstatSync(child);if(now.dev!==opened.dev||now.ino!==opened.ino)throw new Error('setup namespace child changed; retained');rmdirSync(target);}
        finally {closeSync(child);}
      } else if(st.isFile()&&st.nlink===1)unlinkSync(target);
      else throw new Error('setup namespace contains an unsafe entry; retained');
    }} finally {dir.closeSync();}
    fsyncSync(fd);
  };
  try {
    assertOwner(fstatSync(parentFd),parent);
    if(realpathSync(`/proc/self/fd/${parentFd}`)!==parent)throw new Error('setup namespace parent changed; retained');
    const target=join(`/proc/self/fd/${parentFd}`,basename(path));let child:number;
    try {child=openSync(target,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);}
    catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}
    try {remove(child,resolve(path),0);const now=lstatSync(target),opened=fstatSync(child);if(now.dev!==opened.dev||now.ino!==opened.ino)throw new Error('setup namespace changed; retained');rmdirSync(target);fsyncSync(parentFd);}
    finally {closeSync(child);}
  } finally {closeSync(parentFd);}
}

/** Delete only through the verified parent, and only while the captured bytes still match. */
export function safeRemove(path: string, expected: Buffer | null): void {
  checkComponents(path);
  const parent = dirname(resolve(path));
  let dir: number;
  try { dir = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); }
  catch(e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT' && expected === null) return; throw e; }
  let candidate: string | undefined, moved = false, reserved = false;
  try {
    const st = fstatSync(dir); assertOwner(st, parent);
    if (!st.isDirectory() || realpathSync(`/proc/self/fd/${dir}`) !== parent) throw new Error(`setup cannot verify directory: ${parent}`);
    const anchored = join(`/proc/self/fd/${dir}`, basename(path));
    if (expected === null) {
      try { lstatSync(anchored); throw new Error('setup file changed before deletion; retained'); }
      catch(e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
    }
    // Reserve a random exclusive candidate, then inspect what rename actually removed.
    // A replacement at the original basename is never deleted based on an earlier read.
    candidate = join(`/proc/self/fd/${dir}`, `.context-engine-delete-${randomBytes(16).toString('hex')}.tmp`);
    closeSync(openSync(candidate, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)); reserved = true;
    renameSync(anchored, candidate); moved = true; fsyncSync(dir);
    const file = openSync(candidate, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let matches = false;
    try {
      const st = fstatSync(file); assertOwner(st, path);
      if (!st.isFile() || st.nlink !== 1 || st.size !== expected.length || realpathSync(`/proc/self/fd/${file}`) !== join(realpathSync(`/proc/self/fd/${dir}`), basename(candidate))) throw new Error('setup deletion candidate changed; retained');
      const bytes = Buffer.alloc(expected.length + 1); let n = 0;
      for (;;) { const read = readSync(file, bytes, n, bytes.length - n, null); if (!read) break; n += read; if (n === bytes.length) break; }
      matches = n === expected.length && expected.equals(bytes.subarray(0,n));
    } finally { closeSync(file); }
    if (!matches) throw new Error('setup file changed before deletion; retained');
    unlinkSync(candidate); moved = false; reserved = false; fsyncSync(dir);
  } finally {
    try {
      if (candidate && moved) {
        try { linkSync(candidate, join(`/proc/self/fd/${dir}`, basename(path))); unlinkSync(candidate); moved = false; reserved = false; fsyncSync(dir); }
        catch(e) { throw new Error(`setup deletion refused; unrelated candidate retained at ${join(realpathSync(`/proc/self/fd/${dir}`), basename(candidate))}`, { cause: e }); }
      } else if (candidate && reserved) { unlinkSync(candidate); fsyncSync(dir); }
    } finally { closeSync(dir); }
  }
}

/** One runner-wide lease, held until synchronous or asynchronous setup work has finished. */
export function acquireSetupLock(path: string): () => void {
  checkComponents(path);
  const parent = dirname(resolve(path));
  closeSync(openPrivateDirectory(dirname(parent), { create: true })!);
  createParent(parent);
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
