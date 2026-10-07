import * as fs from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { anchoredPath, type AnchoredPath, type FileTarget, type FileInfo, type HostPlatform, type OpenIntent } from './platform-contract.ts';

let descriptorDirectory = '/proc/self/fd';

/** Existing test seam. Production selection never reads an environment override. */
export function setProcFdDir(dir: string | null): void {
  descriptorDirectory = dir ?? '/proc/self/fd';
}

class LinuxPath implements AnchoredPath {
  readonly [anchoredPath] = true;
  readonly value: string;
  constructor(value: string) { this.value = value; }
  toString(): string { return this.value; }
}

function nativePath(path: FileTarget): string {
  if (typeof path === 'string') return path;
  if (path instanceof LinuxPath) return path.value;
  throw new TypeError('foreign opened-directory reference');
}

function related(path: FileTarget, value: string): FileTarget {
  return typeof path === 'string' ? value : new LinuxPath(value);
}

const c = fs.constants;
const openFlags: Record<OpenIntent, number | 'wx'> = {
  directory: c.O_RDONLY | c.O_DIRECTORY | c.O_NOFOLLOW,
  read: c.O_RDONLY | c.O_NOFOLLOW | c.O_NONBLOCK,
  exclusive: 'wx',
  'exclusive-nofollow': c.O_WRONLY | c.O_CREAT | c.O_EXCL | c.O_NOFOLLOW,
  append: c.O_WRONLY | c.O_APPEND | c.O_CREAT | c.O_NOFOLLOW | c.O_NONBLOCK,
  'read-write': c.O_RDWR | c.O_NOFOLLOW | c.O_NONBLOCK,
};

/** Preserve one stat syscall. The backend projects security facts from that inspection. */
function inspect(st: fs.Stats): FileInfo {
  const file = st.isFile(), directory = st.isDirectory(), link = st.isSymbolicLink();
  return {
    dev: st.dev, ino: st.ino, nlink: st.nlink, size: st.size,
    owner: process.getuid ? (st.uid === process.getuid() ? 'current' : 'other') : 'unknown',
    privateAccess: (st.mode & 0o077) === 0,
    isFile: () => file, isDirectory: () => directory, isSymbolicLink: () => link,
  };
}

/** Linux syscall choices. Storage and lock algorithms remain in their callers. */
export const linuxPlatform: HostPlatform = {
  anchor: fd => new LinuxPath(`${descriptorDirectory}/${fd}`),
  openedPath: fd => {
    try { return fs.readlinkSync(`${descriptorDirectory}/${fd}`); }
    catch (error) {
      throw new Error(`cannot verify which file was opened (${descriptorDirectory}/${fd} is unavailable: ${(error as NodeJS.ErrnoException).code ?? error}); refusing to read it. Confined reads need Linux with /proc mounted.`);
    }
  },
  child: (parent, ...names) => related(parent, join(nativePath(parent), ...names) + (names.at(-1) === '.' ? '/.' : '')),
  suffix: (path, suffix) => related(path, nativePath(path) + suffix),
  basename: path => basename(nativePath(path)),
  sameParent: (a, b) => dirname(nativePath(a)) === dirname(nativePath(b)),
  absoluteName: path => resolve(nativePath(path)),
  openSync: (path, intent) => fs.openSync(nativePath(path), openFlags[intent], intent === 'directory' || intent === 'read' ? undefined : 0o600),
  closeSync: fd => fs.closeSync(fd),
  fstatSync: fd => inspect(fs.fstatSync(fd)),
  restrictPrivateAccess: (fd, kind) => fs.fchmodSync(fd, kind === 'directory' ? 0o700 : 0o600),
  fsyncSync: fd => fs.fsyncSync(fd),
  ftruncateSync: (fd, size) => fs.ftruncateSync(fd, size),
  readSync: (fd, bytes, offset, length, position) => fs.readSync(fd, bytes, offset, length, position),
  writeSync: (fd, bytes, offset, length, position) => fs.writeSync(fd, bytes, offset, length, position),
  readFileSync: path => fs.readFileSync(typeof path === 'number' ? path : nativePath(path)),
  writeFileSync: (path, bytes) => fs.writeFileSync(typeof path === 'number' ? path : nativePath(path), bytes),
  lstatSync: path => inspect(fs.lstatSync(nativePath(path))),
  statSync: path => inspect(fs.statSync(nativePath(path))),
  realpathSync: path => fs.realpathSync(nativePath(path)),
  readlinkSync: path => fs.readlinkSync(nativePath(path)),
  existsSync: path => fs.existsSync(nativePath(path)),
  mkdirPrivateSync: (path, options) => { fs.mkdirSync(nativePath(path), { ...options, mode: 0o700 }); },
  readdirSync: path => fs.readdirSync(nativePath(path)),
  opendirSync: path => fs.opendirSync(nativePath(path)),
  renameSync: (from, to) => fs.renameSync(nativePath(from), nativePath(to)),
  linkSync: (from, to) => fs.linkSync(nativePath(from), nativePath(to)),
  unlinkSync: path => fs.unlinkSync(nativePath(path)),
  rmdirSync: path => fs.rmdirSync(nativePath(path)),
  processStartMarker: pid => {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      return fields[19] ?? null;
    } catch { return null; }
  },
};
