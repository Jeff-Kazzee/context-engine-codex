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
import { dirname, join } from 'node:path';
import { mkdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { projectKey, readBytes, resolveStateRoot } from './store.ts';

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
  for (let dir = realpathSync(ref.projectRoot); ; dir = dirname(dir)) {
    const bytes = readBytes(recordPath(stateRoot, dir));
    if (bytes) {
      try {
        const rec = JSON.parse(bytes.toString('utf8'));
        if (rec.projectRoot === dir && (rec.state === 'on' || rec.state === 'off')) return { project: dir, state: rec.state, at: rec.at };
      } catch {
        // A corrupt record counts as no record.
      }
    }
    if (dirname(dir) === dir) return null;
  }
}

export function participation(ref: ParticipationRef & { env?: NodeJS.ProcessEnv }): Participation {
  const killSwitch = killSwitchOn(ref.env ?? process.env);
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
  const path = recordPath(resolveStateRoot(ref.stateDir), realpathSync(ref.projectRoot));
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = join(dirname(path), `.participation-${process.pid}-${randomBytes(16).toString('hex')}.tmp`);
  let created = false;
  try {
    writeFileSync(tmp, `${JSON.stringify({ projectRoot: realpathSync(ref.projectRoot), state: ref.state, at: new Date().toISOString() })}\n`, { mode: 0o600, flag: 'wx' });
    created = true;
    renameSync(tmp, path);
  } finally { if (created) try { unlinkSync(tmp); } catch {} }
}
