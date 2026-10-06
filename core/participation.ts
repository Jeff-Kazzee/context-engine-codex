// Participation: is Context Engine active for a project? Three inputs, checked in this order:
//
// 1. The kill switch: CONTEXT_ENGINE=off (or 0, false, no, disable, disabled) in the environment
//    turns every adapter off without uninstalling anything.
// 2. Per-project records written by `context-engine enable` / `disable`. The nearest record from
//    the project root upward wins, so a subdirectory of an enabled project is enabled, and can be
//    opted out on its own.
// 3. The rollout default, used when no record applies. During the pilot it is off (opt-in).
//
// Records live in the state root (never in the project): participation/<project key>.json.
import { basename, dirname, join } from 'node:path';
import { closeSync, constants, fstatSync, fsyncSync, openSync, readSync, realpathSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { openPrivateDirectory, projectKey, resolveStateRoot } from './store.ts';

export const KILL_SWITCH_ENV = 'CONTEXT_ENGINE';
const OFF_VALUES = new Set(['off', '0', 'false', 'no', 'disable', 'disabled']);

/** The rollout default for projects with no record. Opt-in during the pilot (issue #8). */
export const ROLLOUT_DEFAULT: 'on' | 'off' = 'off';

export function killSwitchOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return OFF_VALUES.has((env[KILL_SWITCH_ENV] ?? '').trim().toLowerCase());
}

export interface Participation {
  active: boolean;
  /** The record that decided ('on' or 'off'), or 'default' when none applies. */
  state: 'on' | 'off' | 'default';
  /** The directory whose record decided, or null. */
  project: string | null;
  killSwitch: boolean;
  /** One line for people: why Context Engine is or isn't active here. */
  reason: string;
}

export interface ParticipationRef {
  projectRoot: string;
  /** State root override, as for openSession. */
  stateDir?: string;
}

const recordPath = (stateRoot: string, dir: string) => {
  const key = projectKey(dir);
  // Existing .json names up to 255 bytes stay unchanged. Larger records never
  // fit before; keep the full digest while shortening their readable prefix.
  return join(stateRoot, 'participation', `${key.length <= 250 ? key : `${key.slice(0, 128)}-${key.slice(-64)}`}.json`);
};

/** The nearest participation record at or above `projectRoot`. */
export function findRecord(ref: ParticipationRef): { project: string; state: 'on' | 'off'; at?: string } | null {
  const stateRoot = resolveStateRoot(ref.stateDir);
  const rootFd = openPrivateDirectory(stateRoot);
  if (rootFd === undefined) return null;
  let dirFd: number | undefined;
  try {
  dirFd = openPrivateDirectory(join(stateRoot, 'participation'));
  if (dirFd === undefined) return null;
  for (let dir = realpathSync(ref.projectRoot); ; dir = dirname(dir)) {
    const expected = recordPath(stateRoot, dir);
    let recordFd: number;
    try { recordFd = openSync(join(`/proc/self/fd/${dirFd}`, basename(expected)), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') { if (dirname(dir) === dir) return null; continue; } throw e; }
    let bytes: Buffer;
    try {
      const st = fstatSync(recordFd);
      if (!st.isFile() || st.nlink !== 1 || st.size > 16384 || (process.getuid && st.uid !== process.getuid()) || (st.mode & 0o077) !== 0 || realpathSync(`/proc/self/fd/${recordFd}`) !== expected) throw new Error('participation record is not a verified bounded private regular file');
      const buffer = Buffer.alloc(16385);
      let used = 0;
      while (used < buffer.length) {
        const n = readSync(recordFd, buffer, used, buffer.length - used, used);
        if (!n) break;
        used += n;
      }
      if (used > 16384) throw new Error('participation record exceeds read limit');
      bytes = buffer.subarray(0, used);
    } finally { closeSync(recordFd); }
    if (bytes) {
      try {
        const rec = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        if (rec.projectRoot === dir && (rec.state === 'on' || rec.state === 'off')) return { project: dir, state: rec.state, at: rec.at };
      } catch {
        // An existing corrupt record must not inherit an ancestor's opt-in.
      }
      return { project: dir, state: 'off' };
    }
    if (dirname(dir) === dir) return null;
  }
  } finally { if (dirFd !== undefined) closeSync(dirFd); closeSync(rootFd); }
}

export function participation(ref: ParticipationRef & { env?: NodeJS.ProcessEnv }): Participation {
  const killSwitch = killSwitchOn(ref.env ?? process.env);
  if (killSwitch) return { active: false, state: 'default', project: null, killSwitch: true, reason: `turned off by the kill switch ${KILL_SWITCH_ENV}=${(ref.env ?? process.env)[KILL_SWITCH_ENV]}` };
  const rec = findRecord(ref);
  const state = rec?.state ?? 'default';
  const on = (rec?.state ?? ROLLOUT_DEFAULT) === 'on';
  let reason: string;
  if (killSwitch) reason = `turned off by the kill switch ${KILL_SWITCH_ENV}=${(ref.env ?? process.env)[KILL_SWITCH_ENV]}`;
  else if (rec?.state === 'on') reason = `enabled for ${rec.project}`;
  else if (rec?.state === 'off') reason = `disabled for ${rec.project} (this distribution's disable command)`;
  else reason = on ? 'on by default' : "not enabled for this project (the pilot is opt-in: use this distribution's runtime-specific enable command)";
  return { active: on && !killSwitch, state, project: rec?.project ?? null, killSwitch, reason };
}

/** Writes this directory's record (atomic). */
export function setParticipation(ref: ParticipationRef & { state: 'on' | 'off' }): void {
  const stateRoot = resolveStateRoot(ref.stateDir), projectRoot = realpathSync(ref.projectRoot);
  const path = recordPath(stateRoot, projectRoot);
  const rootFd = openPrivateDirectory(stateRoot, { create: true })!;
  let dirFd: number | undefined;
  let tmp: string | undefined;
  let created = false;
  try {
    dirFd = openPrivateDirectory(dirname(path), { create: true })!;
    const anchored = `/proc/self/fd/${dirFd}`;
    tmp = join(anchored, `.participation-${process.pid}-${randomBytes(16).toString('hex')}.tmp`);
    const file = openSync(tmp, 'wx', 0o600);
    created = true;
    try {
      const bytes = Buffer.from(`${JSON.stringify({ projectRoot, state: ref.state, at: new Date().toISOString() })}\n`);
      for (let offset = 0; offset < bytes.length;) {
        const written = writeSync(file, bytes, offset, bytes.length - offset);
        if (written <= 0) throw new Error('participation write made no progress; refusing publication');
        offset += written;
      }
      fsyncSync(file);
    } finally { closeSync(file); }
    if (realpathSync(anchored) !== dirname(path)) throw new Error('participation directory changed before publication');
    renameSync(tmp, join(anchored, basename(path)));
    fsyncSync(dirFd);
    fsyncSync(rootFd);
  } finally {
    if (created && tmp) try { unlinkSync(tmp); } catch {}
    if (dirFd !== undefined) closeSync(dirFd);
    closeSync(rootFd);
  }
}
