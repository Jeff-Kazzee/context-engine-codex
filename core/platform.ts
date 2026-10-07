import type { FileTarget, HostPlatform, OpenIntent } from './platform-contract.ts';
import { linuxPlatform } from './platform-linux.ts';
export type { AnchoredPath, Descriptor, FileInfo, FileTarget, HostPlatform, OpenIntent } from './platform-contract.ts';

export class UnsupportedPlatformError extends Error {
  readonly code = 'CE_UNSUPPORTED_PLATFORM';
  readonly platform: string;
  constructor(platform: string) {
    super(`Context Engine stateful operations are unsupported on ${platform}: no verified host backend is available. Use the Linux backend with /proc mounted. No state was changed.`);
    this.name = 'UnsupportedPlatformError';
    this.platform = platform;
  }
}

export function requireSupportedPlatform(platform: NodeJS.Platform = process.platform): void {
  if (platform !== 'linux') throw new UnsupportedPlatformError(platform);
}

function host(): HostPlatform {
  requireSupportedPlatform();
  return linuxPlatform;
}

export const anchor = (fd: number) => host().anchor(fd);
export const openedPath = (fd: number) => host().openedPath(fd);
export const childTarget = (parent: FileTarget, ...names: string[]) => host().child(parent, ...names);
export const suffix = (path: FileTarget, suffix: string) => host().suffix(path, suffix);
export const targetBasename = (path: FileTarget) => host().basename(path);
export const sameParent = (a: FileTarget, b: FileTarget) => host().sameParent(a, b);
export const absoluteName = (path: FileTarget) => host().absoluteName(path);
export const openSync = (path: FileTarget, intent: OpenIntent) => host().openSync(path, intent);
export const closeSync: HostPlatform['closeSync'] = fd => host().closeSync(fd);
export const fstatSync: HostPlatform['fstatSync'] = fd => host().fstatSync(fd);
export const restrictPrivateAccess: HostPlatform['restrictPrivateAccess'] = (fd, kind) => host().restrictPrivateAccess(fd, kind);
export const fsyncSync: HostPlatform['fsyncSync'] = fd => host().fsyncSync(fd);
export const ftruncateSync: HostPlatform['ftruncateSync'] = (fd, size) => host().ftruncateSync(fd, size);
export const readSync: HostPlatform['readSync'] = (fd, bytes, offset, length, position) => host().readSync(fd, bytes, offset, length, position);
export const writeSync: HostPlatform['writeSync'] = (fd, bytes, offset, length, position) => host().writeSync(fd, bytes, offset, length, position);
export const readFileSync: HostPlatform['readFileSync'] = path => host().readFileSync(path);
export const writeFileSync: HostPlatform['writeFileSync'] = (path, bytes) => host().writeFileSync(path, bytes);
export const lstatSync: HostPlatform['lstatSync'] = path => host().lstatSync(path);
export const statSync: HostPlatform['statSync'] = path => host().statSync(path);
export const realpathSync: HostPlatform['realpathSync'] = path => host().realpathSync(path);
export const readlinkSync: HostPlatform['readlinkSync'] = path => host().readlinkSync(path);
export const existsSync: HostPlatform['existsSync'] = path => host().existsSync(path);
export const mkdirPrivateSync: HostPlatform['mkdirPrivateSync'] = (path, options) => host().mkdirPrivateSync(path, options);
export const readdirSync: HostPlatform['readdirSync'] = path => host().readdirSync(path);
export const opendirSync: HostPlatform['opendirSync'] = path => host().opendirSync(path);
export const renameSync: HostPlatform['renameSync'] = (from, to) => host().renameSync(from, to);
export const linkSync: HostPlatform['linkSync'] = (from, to) => host().linkSync(from, to);
export const unlinkSync: HostPlatform['unlinkSync'] = path => host().unlinkSync(path);
export const rmdirSync: HostPlatform['rmdirSync'] = path => host().rmdirSync(path);
export const processStartMarker: HostPlatform['processStartMarker'] = pid => host().processStartMarker(pid);
