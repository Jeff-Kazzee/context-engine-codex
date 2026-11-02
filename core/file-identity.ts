/** Linux retains numeric identities. Windows uses lossless, tagged volume/file IDs. */
export interface FileIdentity {
  readonly dev: number | string;
  readonly ino: number | string;
}

/** Do not accept a partial, mixed, rounded or malformed persisted identity. */
export function validFileIdentity(value: unknown): value is FileIdentity {
  if (typeof value !== 'object' || value === null || !('dev' in value) || !('ino' in value)) return false;
  if (typeof value.dev === 'number' && typeof value.ino === 'number') {
    return Number.isSafeInteger(value.dev) && value.dev >= 0 && Number.isSafeInteger(value.ino) && value.ino > 0;
  }
  return typeof value.dev === 'string' && /^win32-volume:[0-9a-f]{16}$/.test(value.dev)
    && typeof value.ino === 'string' && /^win32-file:[0-9a-f]{32}$/.test(value.ino);
}
