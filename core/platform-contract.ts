import type { FileIdentity } from './file-identity.ts';

/** A backend-owned handle. Use only this backend to operate on or close it. */
export type Descriptor = number;
export const anchoredPath = Symbol('opened-directory reference');
/** A backend-owned location relative to an open directory, not a filesystem path. */
export interface AnchoredPath { readonly [anchoredPath]: true }
export type FileTarget = string | AnchoredPath;
export type OpenIntent = 'directory' | 'read' | 'exclusive' | 'exclusive-nofollow' | 'append' | 'append-existing' | 'read-write';

/** Facts inspected by the backend from the actual handle or target. */
export interface FileInfo extends FileIdentity {
  readonly nlink: number;
  readonly size: number;
  readonly owner: 'current' | 'other' | 'unknown';
  readonly privateAccess: boolean;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

/** Linux reports actual scheduler state and thread count from one /proc read. */
export interface LinuxProcessStatus {
  readonly kind?: 'linux-proc';
  state: string;
  threads: number;
  startMarker: string;
}

/** Windows tests one process HANDLE, with its exact creation marker. */
export interface WindowsProcessStatus {
  readonly kind: 'windows-process';
  alive: boolean;
  startMarker: string;
}
export type ProcessStatus = LinuxProcessStatus | WindowsProcessStatus;

export interface FileObservation {
  dev: string; ino: string; size: number; mtime: string; ctime: string;
}

export interface DirectoryCursor {
  readSync(): { readonly name: string } | null;
  closeSync(): void;
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
  /** Exact identity/change fields for one unlinked regular log file. */
  observeFileSync(path: FileTarget): FileObservation;
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
  opendirSync(path: FileTarget): DirectoryCursor;
  renameSync(from: FileTarget, to: FileTarget): void;
  linkSync(from: FileTarget, to: FileTarget): void;
  unlinkSync(path: FileTarget): void;
  rmdirSync(path: FileTarget): void;
  processStartMarker(pid: number): string | null;
  /** The process's status from one read, or null when it is absent, unreadable or does not parse. */
  processStatus(pid: number): ProcessStatus | null;
}
