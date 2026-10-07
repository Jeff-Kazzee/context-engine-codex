import type { Dir } from 'node:fs';

/** An open Node handle. Callers do not derive filesystem paths from its number. */
export type Descriptor = number;
export const anchoredPath = Symbol('opened-directory reference');
/** A backend-owned location relative to an open directory, not a filesystem path. */
export interface AnchoredPath { readonly [anchoredPath]: true }
export type FileTarget = string | AnchoredPath;
export type OpenIntent = 'directory' | 'read' | 'exclusive' | 'exclusive-nofollow' | 'append' | 'read-write';

/** Facts inspected by the backend from the actual handle or target. */
export interface FileInfo {
  readonly dev: number;
  readonly ino: number;
  readonly nlink: number;
  readonly size: number;
  readonly owner: 'current' | 'other' | 'unknown';
  readonly privateAccess: boolean;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

/** Synchronous operations already used by storage, locking, and setup. */
export interface HostPlatform {
  anchor(fd: Descriptor): AnchoredPath;
  openedPath(fd: Descriptor): string;
  child(parent: FileTarget, ...names: string[]): FileTarget;
  suffix(path: FileTarget, suffix: string): FileTarget;
  basename(path: FileTarget): string;
  sameParent(a: FileTarget, b: FileTarget): boolean;
  absoluteName(path: FileTarget): string;
  openSync(path: FileTarget, intent: OpenIntent): Descriptor;
  closeSync(fd: Descriptor): void;
  fstatSync(fd: Descriptor): FileInfo;
  restrictPrivateAccess(fd: Descriptor, kind: 'file' | 'directory'): void;
  fsyncSync(fd: Descriptor): void;
  ftruncateSync(fd: Descriptor, size: number): void;
  readSync(fd: Descriptor, bytes: Uint8Array, offset: number, length: number, position: number | null): number;
  writeSync(fd: Descriptor, bytes: Uint8Array, offset?: number, length?: number, position?: number | null): number;
  readFileSync(path: FileTarget | Descriptor): Buffer;
  writeFileSync(path: FileTarget | Descriptor, bytes: string | Uint8Array): void;
  lstatSync(path: FileTarget): FileInfo;
  statSync(path: FileTarget): FileInfo;
  realpathSync(path: FileTarget): string;
  readlinkSync(path: FileTarget): string;
  existsSync(path: FileTarget): boolean;
  mkdirPrivateSync(path: FileTarget, options?: { recursive?: boolean }): void;
  readdirSync(path: FileTarget): string[];
  opendirSync(path: FileTarget): Dir;
  renameSync(from: FileTarget, to: FileTarget): void;
  linkSync(from: FileTarget, to: FileTarget): void;
  unlinkSync(path: FileTarget): void;
  rmdirSync(path: FileTarget): void;
  processStartMarker(pid: number): string | null;
}
