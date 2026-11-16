import { assertSupportedNode } from '../setup/node-runtime.mjs';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { constants as bufferConstants } from 'node:buffer';
import { anchoredPath, type AnchoredPath, type FileInfo, type FileTarget, type HostPlatform, type OpenIntent, type ProcessStatus } from './platform-contract.ts';
import { validFileIdentity } from './file-identity.ts';
import { assertWindowsComponent } from './windows-path.ts';

interface NativeInfo { dev: string; ino: string; nlink: number; size: number; owner: 'current' | 'other'; privateAccess: boolean; mtime: string; ctime: string; directory: boolean; reparse: boolean }
interface NativeBinding { contractVersion: number; call(operation: string, ...args: unknown[]): unknown }

/** Explicit construction does not change the production platform selector. */
export function createWindowsPlatform(): HostPlatform {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw Object.assign(new Error('Windows backend requires native Windows x64'), { code: 'CE_UNSUPPORTED_PLATFORM' });
  assertSupportedNode();
  const require = createRequire(import.meta.url);
  let native: NativeBinding;
  try { native = require('../native/windows/build/ce_windows.node') as NativeBinding; }
  catch (cause) { throw Object.assign(new Error('Verified Windows native addon is unavailable. Build it from this checkout before stateful acceptance.', { cause }), { code: 'CE_WINDOWS_BACKEND_UNAVAILABLE' }); }
  if (native.contractVersion !== 1 || typeof native.call !== 'function') throw new Error('Windows native addon contract mismatch');
  const call = <T>(operation: string, ...args: unknown[]): T => native.call(operation, ...args) as T;
  class WindowsPath implements AnchoredPath {
    readonly [anchoredPath] = true;
    readonly fd: number;
    readonly names: readonly string[];
    constructor(fd: number, names: readonly string[]) { this.fd = fd; this.names = [...names]; }
  }
  const close = (fd: number): void => { call('close', fd); };
  function parts(name: string): string[] {
    if (name.includes('\0') || /^[\\/]/.test(name) || /^[a-z]:/i.test(name)) throw new Error('absolute child path refused');
    const result = name.split(/[\\/]/).filter(part => part !== '' && part !== '.');
    for (const name of result) assertWindowsComponent(name);
    return result;
  }
  function location(path: FileTarget): { start: number; names: string[]; owned: boolean } {
    if (path instanceof WindowsPath) return { start: path.fd, names: [...path.names], owned: false };
    if (typeof path !== 'string') throw new TypeError('foreign opened-directory reference');
    if (!isAbsolute(path) || !/^[a-z]:[\\/]/i.test(path) || path.startsWith('\\\\')) throw new Error('only absolute local Windows drive paths are supported');
    const root = parse(path).root;
    const names = parts(path.slice(root.length));
    return { start: call<number>('root', root.replaceAll('/', '\\')), names, owned: true };
  }
  function parent<T>(path: FileTarget, fn: (fd: number, name: string) => T): T {
    const loc = location(path); let fd = loc.start, owned = loc.owned;
    try {
      if (!loc.names.length) throw new Error('namespace mutation requires a child name');
      for (const name of loc.names.slice(0, -1)) {
        const next = call<number>('open', fd, name, 'directory');
        if (owned) close(fd); fd = next; owned = true;
      }
      return fn(fd, loc.names.at(-1)!);
    } finally { if (owned) close(fd); }
  }
  function open(path: FileTarget, intent: OpenIntent | 'inspect'): number {
    const loc = location(path); let fd = loc.start, owned = loc.owned;
    try {
      if (!loc.names.length) {
        if (intent !== 'directory' && intent !== 'inspect') throw new Error('file operation on drive or anchored directory refused');
        if (!owned) fd = call<number>('reopen-directory', fd);
        owned = false; return fd;
      }
      for (let i = 0; i < loc.names.length; i++) {
        const next = call<number>('open', fd, loc.names[i]!, i === loc.names.length - 1 ? intent : 'directory');
        if (owned) close(fd); fd = next; owned = true;
      }
      owned = false; return fd;
    } finally { if (owned) close(fd); }
  }
  function info(fd: number): FileInfo {
    const st = call<NativeInfo>('inspect', fd);
    if (!validFileIdentity(st)) throw new Error('native identity was malformed');
    return { ...st, isFile: () => !st.directory && !st.reparse, isDirectory: () => st.directory && !st.reparse, isSymbolicLink: () => st.reparse };
  }
  function withFile<T>(path: FileTarget, intent: OpenIntent | 'inspect', fn: (fd: number) => T): T {
    const fd = open(path, intent); try { return fn(fd); } finally { close(fd); }
  }
  function inspectPath(path: FileTarget): FileInfo { return withFile(path, 'inspect', info); }
  function absolute(path: FileTarget): string {
    if (typeof path === 'string') return resolve(path);
    if (!(path instanceof WindowsPath)) throw new TypeError('foreign opened-directory reference');
    return join(call<string>('path', path.fd), ...path.names);
  }
  function readFile(fd: number): Buffer {
    const st = info(fd);
    if (!st.isFile() || st.size > bufferConstants.MAX_LENGTH) throw new Error('opened file is not a bounded regular file');
    const bytes = Buffer.alloc(st.size); let used = 0;
    while (used < bytes.length) {
      const count = call<number>('read', fd, bytes, used, Math.min(bytes.length - used, 65536), null);
      if (!count) break; used += count;
    }
    return bytes.subarray(0, used);
  }
  function writeFile(fd: number, bytes: string | Uint8Array): void {
    const data = typeof bytes === 'string' ? Buffer.from(bytes) : bytes;
    for (let done = 0; done < data.length;) {
      const count = call<number>('write', fd, data, done, Math.min(data.length - done, 65536), null);
      if (count <= 0) throw new Error('file write made no progress'); done += count;
    }
  }
  const backend: HostPlatform = {
    anchor: fd => { info(fd); return new WindowsPath(fd, []); },
    openedPath: fd => call<string>('path', fd),
    child: (path, ...names) => {
      const children = names.flatMap(parts);
      if (typeof path === 'string') return join(path, ...children);
      if (!(path instanceof WindowsPath)) throw new TypeError('foreign opened-directory reference');
      return new WindowsPath(path.fd, [...path.names, ...children]);
    },
    suffix: (path, ending) => {
      if (parts(ending).length !== 1 || /[\\/]/.test(ending)) throw new Error('invalid path suffix');
      if (typeof path === 'string') return path + ending;
      if (!(path instanceof WindowsPath) || !path.names.length) throw new Error('suffix requires a child name');
      return new WindowsPath(path.fd, [...path.names.slice(0, -1), path.names.at(-1)! + ending]);
    },
    basename: path => basename(absolute(path)),
    sameParent: (a, b) => parent(a, (aFd) => parent(b, (bFd) => {
      const x = info(aFd), y = info(bFd); return x.dev === y.dev && x.ino === y.ino;
    })),
    absoluteName: absolute,
    openSync: open,
    closeSync: close,
    fstatSync: info,
    observeFileSync: path => withFile(path, 'read', fd => {
      const st = call<NativeInfo>('inspect', fd);
      if (!validFileIdentity(st) || st.directory || st.reparse || st.nlink !== 1 || !Number.isSafeInteger(st.size)) throw new Error('invalid regular log observation');
      return { dev: st.dev, ino: st.ino, size: st.size, mtime: st.mtime, ctime: st.ctime };
    }),
    restrictPrivateAccess: fd => { call('private', fd); },
    fsyncSync: fd => { call('flush', fd); },
    ftruncateSync: (fd, size) => { call('truncate', fd, size); },
    readSync: (fd, bytes, offset, length, position) => call<number>('read', fd, bytes, offset, length, position),
    writeSync: (fd, bytes, offset = 0, length = bytes.length - offset, position = null) => call<number>('write', fd, bytes, offset, length, position),
    readFileSync: path => typeof path === 'number' ? readFile(path) : withFile(path, 'read', readFile),
    writeFileSync: (path, bytes) => {
      if (typeof path === 'number') return writeFile(path, bytes);
      let fd: number;
      try { fd = open(path, 'read-write'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; fd = open(path, 'exclusive'); }
      try { if (!info(fd).isFile()) throw new Error('write target is not a regular file'); call('truncate', fd, 0); writeFile(fd, bytes); }
      finally { close(fd); }
    },
    lstatSync: inspectPath,
    statSync: path => withFile(path, 'inspect', fd => {
      const st = info(fd); if (st.isSymbolicLink()) throw Object.assign(new Error('reparse target refused'), { code: 'ELOOP' }); return st;
    }),
    realpathSync: path => withFile(path, 'inspect', fd => {
      if (info(fd).isSymbolicLink()) throw Object.assign(new Error('reparse target refused'), { code: 'ELOOP' }); return call<string>('path', fd);
    }),
    readlinkSync: () => { throw Object.assign(new Error('Windows reparse links are not accepted as filesystem paths'), { code: 'ELOOP' }); },
    existsSync: path => { try { inspectPath(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } },
    mkdirPrivateSync: (path, options) => {
      if (!options?.recursive) return parent(path, (fd, name) => { call('mkdir', fd, name); });
      const loc = location(path); let fd = loc.start, owned = loc.owned;
      try { for (const name of loc.names) {
        try { call('mkdir', fd, name); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
        const next = call<number>('open', fd, name, 'directory'); if (owned) close(fd); fd = next; owned = true;
      }} finally { if (owned) close(fd); }
    },
    readdirSync: path => {
      const cursor = backend.opendirSync(path), names: string[] = [];
      try { for (let entry; (entry = cursor.readSync()) !== null;) names.push(entry.name); return names; }
      finally { cursor.closeSync(); }
    },
    opendirSync: path => {
      const fd = open(path, 'directory'); let closed = false;
      return {
        readSync() { if (closed) throw Object.assign(new Error('directory cursor is closed'), { code: 'ERR_DIR_CLOSED' }); const name = call<string | null>('next', fd); return name === null ? null : { name }; },
        closeSync() { if (closed) throw Object.assign(new Error('directory cursor is closed'), { code: 'ERR_DIR_CLOSED' }); closed = true; close(fd); },
      };
    },
    renameSync: (from, to) => parent(from, (source, name) => parent(to, (target, targetName) => { call('rename', source, name, target, targetName); })),
    linkSync: (from, to) => parent(from, (source, name) => parent(to, (target, targetName) => { call('link', source, name, target, targetName); })),
    unlinkSync: path => parent(path, (fd, name) => { call('unlink', fd, name); }),
    rmdirSync: path => parent(path, (fd, name) => { call('rmdir', fd, name); }),
    processStartMarker: pid => call<ProcessStatus | null>('process', pid)?.startMarker ?? null,
    processStatus: pid => call<ProcessStatus | null>('process', pid),
  };
  return backend;
}
