import { anchor, childTarget } from '../core/platform.ts';
// Install and uninstall one runner's adapter through the runner's own plugin commands, with every
// config file they touch backed up byte for byte first (ledger.ts).
import { closeSync, existsSync, fsyncSync, linkSync, mkdirPrivateSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from '../core/platform.ts';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { assess, completeLedger, type FileReport, type Ledger, preflightOwnership, readLedger, revert, rollbackSnapshot, type Snapshot, takeSnapshot } from './ledger.ts';
import { checkOwnedDirectory, safeRead, safeWrite, withSetupLock } from './files.ts';
import { openPrivateDirectory } from '../core/store.ts';
import { codexSpec, runBinary, type RunnerSpec, type SetupContext } from './runners.ts';

const pointerPath = (ctx: SetupContext, id: string) => join(ctx.setupDir, `${id}.json`);
/** The snapshot of an install that has started changing runner config and has not yet published or rolled back. */
const pendingPath = (ctx: SetupContext, id: string) => join(ctx.setupDir, `${id}.pending.json`);

function removePending(ctx: SetupContext, id: string): void {
  const parent = openPrivateDirectory(ctx.setupDir)!;
  try {
    try { unlinkSync(childTarget(anchor(parent), `${id}.pending.json`)); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
    fsyncSync(parent);
  } finally { closeSync(parent); }
}

/** A killed install's snapshot, accepted only when every path in it is the one this runner's policy derives. */
export function interruptedInstall(ctx: SetupContext, spec: RunnerSpec): Snapshot | null {
  const bytes = safeRead(pendingPath(ctx, spec.id));
  if (bytes === null) return null;
  // Setup cannot undo from a record it cannot verify, so every command refuses until the user moves it aside.
  const unusable = (problem: string) => new SetupError(`${spec.title}: the interrupted install record ${problem}: ${pendingPath(ctx, spec.id)}. Setup cannot verify what it would undo, so it changed nothing. Compare the tracked configuration with the before backups under ${join(ctx.setupDir, 'backups')} and repair it by hand if needed, then move the record aside and run setup again.`);
  let s: Snapshot;
  try { s = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as Snapshot; }
  catch { throw unusable('is not valid JSON'); }
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const copy = (i: number) => join(s.dir, 'before', `${i}-${basename(spec.files[i]!)}`);
  if (typeof s !== 'object' || s === null || typeof s.dir !== 'string' || resolve(s.dir) !== s.dir || dirname(s.dir) !== join(ctx.setupDir, 'backups') || !basename(s.dir).startsWith(`${spec.id}-`)
    || !Array.isArray(s.files) || !same(s.files.map((f) => f.path), spec.files) || !s.files.every((f, i) => f.after === null && (f.before === null || f.before === copy(i)))
    || !Array.isArray(s.namespaced) || !same(s.namespaced.map((n) => n.path), spec.namespaced) || !s.namespaced.every((n) => typeof n.existed === 'boolean')
    || !same(s.watch, spec.watch) || !Array.isArray(s.listing) || !s.listing.every((p) => typeof p === 'string')) {
    throw unusable('violates confinement policy');
  }
  const snapshot = openPrivateDirectory(s.dir);
  if (snapshot === undefined) throw unusable(`names a snapshot that is missing (${s.dir})`);
  closeSync(snapshot);
  // A missing copy would read as a file that did not exist, and the undo would delete the live file.
  const missing = s.files.find((f) => f.before !== null && safeRead(f.before) === null);
  if (missing) throw new SetupError(`${spec.title}: the before backup of ${missing.path} is missing, so setup cannot undo the interrupted install and changed nothing. Restore ${missing.before}, then run setup again. Interrupted install record: ${pendingPath(ctx, spec.id)}`);
  return s;
}

/**
 * Enable and status refuse while a killed install is not undone. Only install and uninstall undo it. A record
 * whose snapshot the install record names belongs to a finished install that was killed before it removed the
 * record. It is not refused, and a caller that holds the setup lock removes it.
 */
export function refuseInterruptedInstall(ctx: SetupContext, spec: RunnerSpec, locked: boolean): void {
  const snap = interruptedInstall(ctx, spec);
  if (!snap) return;
  if (installedLedger(ctx, spec.id, spec)?.dir === snap.dir) {
    if (locked) removePending(ctx, spec.id);
    return;
  }
  throw new SetupError(`${spec.title}: an install did not finish, and its configuration changes are not undone. Run \`context-engine-${spec.id} uninstall\` to undo them, or \`context-engine-${spec.id} install\` to undo them and install again. Interrupted install record: ${pendingPath(ctx, spec.id)}. Its before backups: ${join(snap.dir, 'before')}`);
}

/**
 * Status takes no lock. Without a setup lock, an interrupted install record that is not a finished install's
 * means a killed install, and status refuses as enable does. With the lock present an install may still be
 * running, so status gets a line that names the lock and the record instead of "not installed".
 */
export function interruptedInstallStatus(ctx: SetupContext, spec: RunnerSpec): string | null {
  const lock = join(ctx.setupDir, `${spec.id}.setup.lock`);
  if (!existsSync(lock)) { refuseInterruptedInstall(ctx, spec, false); return null; }
  const snap = interruptedInstall(ctx, spec);
  if (!snap || installedLedger(ctx, spec.id, spec)?.dir === snap.dir) return null;
  return `an install is running, or was killed and left its setup lock. Setup lock: ${lock}. Interrupted install record: ${pendingPath(ctx, spec.id)}`;
}

/** A SIGKILL skips the rollback in installLocked, so the next run finishes it before anything else. */
function undoInterruptedInstall(ctx: SetupContext, spec: RunnerSpec): string[] {
  const snap = interruptedInstall(ctx, spec);
  if (!snap) return [];
  let retained: string[];
  try {
    checkOwnedDirectory(spec.home);
    preflightOwnership(spec);
    retained = rollbackSnapshot(snap, spec.rules);
  } catch (e) {
    // The record stays, so the next install or uninstall repeats the undo once the cause is repaired.
    const cause = (e instanceof Error ? e.message : String(e)).replace(/\.$/, '');
    throw new SetupError(`${spec.title}: an earlier install was interrupted, and its undo stopped: ${cause}. Repair that, then run \`context-engine-${spec.id} install\` or \`context-engine-${spec.id} uninstall\` again. Interrupted install record: ${pendingPath(ctx, spec.id)}. Its before backups: ${join(snap.dir, 'before')}`, { cause: e });
  }
  removePending(ctx, spec.id);
  return [
    'An earlier install was interrupted. Its configuration changes were rolled back and unmanaged edits were kept.',
    `Unowned new paths retained from it: ${retained.length}. Its before backups: ${join(snap.dir, 'before')}`,
  ];
}

/** Inspect an atomically moved candidate; never delete a later writer's pointer name. */
function removeFailedPointer(ctx: SetupContext, id: string, publication: string): void {
  const parent = openPrivateDirectory(ctx.setupDir)!;
  const name = `.context-engine-install-cleanup-${randomBytes(16).toString('hex')}.tmp`;
  const anchored = anchor(parent), pointer = childTarget(anchored, `${id}.json`), candidate = childTarget(anchored, name);
  let moved = false, reserved = false;
  try {
    // Reserve our scratch name exclusively; never overwrite a preexisting capture.
    closeSync(openSync(candidate, 'exclusive-nofollow')); reserved = true;
    try { renameSync(pointer, candidate); moved = true; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    if (!moved) return;
    fsyncSync(parent);
    if (safeRead(join(ctx.setupDir, name))?.equals(Buffer.from(publication))) {
      unlinkSync(candidate); reserved = false; moved = false; fsyncSync(parent);
    }
  } finally {
    try {
      if (moved) {
        // Restore an unrelated candidate without overwriting any newer pointer.
        try { linkSync(candidate, pointer); unlinkSync(candidate); reserved = false; moved = false; }
        catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`install pointer changed during cleanup; unrelated candidate preserved at ${join(ctx.setupDir, name)}`);
          throw e;
        }
        fsyncSync(parent);
      } else if (reserved) { unlinkSync(candidate); fsyncSync(parent); }
    } finally { closeSync(parent); }
  }
}

/** The install ledger of a runner, or null when Context Engine isn't installed there. */
export function installedLedger(ctx: SetupContext, id: string, spec?: RunnerSpec): Ledger | null {
  const p = pointerPath(ctx, id);
  const bytes = safeRead(p);
  if (bytes === null) return null;
  spec ??= codexSpec(ctx);
  return readLedger(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)).dir, {backupRoot:join(ctx.setupDir,'backups'),files:spec.files,namespaced:spec.namespaced});
}

export class SetupError extends Error {}

export function install(ctx: SetupContext, spec: RunnerSpec): string[] {
  return withSetupLock(join(ctx.setupDir, `${spec.id}.setup.lock`), () => installLocked(ctx, spec));
}

export function installLocked(ctx: SetupContext, spec: RunnerSpec): string[] {
  checkOwnedDirectory(spec.home);
  const prior = installedLedger(ctx, spec.id, spec);
  if (prior) {
    // A kill between publishing the install record and removing the interrupted record leaves a finished install.
    if (interruptedInstall(ctx, spec)?.dir === prior.dir) removePending(ctx, spec.id);
    throw new SetupError(`${spec.title}: already installed (${prior.at}); run \`context-engine-${spec.id} uninstall\` first`);
  }
  const recovered = undoInterruptedInstall(ctx, spec);
  const snap = takeSnapshot({ backupRoot: join(ctx.setupDir, 'backups'), kind: spec.id, files: spec.files, watch: spec.watch, namespaced: spec.namespaced });
  let publication: string | undefined;
  try {
    safeWrite(pendingPath(ctx, spec.id), `${JSON.stringify(snap)}\n`);
    spec.prepare?.();
    for (const cmd of spec.install) {
      const r = runBinary(spec.bin, cmd, ctx.env);
      if (!r.ok) {
        // The transaction catch restores tracked configuration on any failure.
        throw new SetupError(`${spec.title}: \`${spec.bin} ${cmd.join(' ')}\` failed: ${r.output.slice(0, 500)}`);
      }
    }
    const ledger = completeLedger(snap);
    mkdirPrivateSync(ctx.setupDir, { recursive: true });
    publication = `${JSON.stringify({ dir: ledger.dir })}\n`;
    safeWrite(pointerPath(ctx, spec.id), publication);
    removePending(ctx, spec.id);
    const changed = ledger.files.filter((f) => !sameBytes(f.before, f.after)).map((f) => f.path);
    return [
      ...recovered,
      `Changed by \`${spec.bin} plugin\`: ${changed.join(', ') || '(no config file)'}`,
      `Byte backups taken before the change: ${join(ledger.dir, 'before')}`,
      `New paths outside Context Engine namespaces retained: ${ledger.retainedPaths?.length ?? 0} (ownership unverified; uninstall will leave them alone)`,
    ];
  } catch (e) {
    // The undo of an interrupted install already finished, so a failure report keeps its lines.
    const report = (message: string) => [message, ...recovered].join('\n');
    let retained: string[];
    try { retained = rollbackSnapshot(snap, spec.rules); removePending(ctx, spec.id); }
    catch (rollbackError) { throw new AggregateError([e, rollbackError], report(`${spec.title}: install failed and rollback was incomplete; before backups are preserved at ${join(snap.dir, 'before')}`)); }
    // A rename may publish before its directory flush throws. Remove only our pointer.
    if (publication && safeRead(pointerPath(ctx, spec.id))?.equals(Buffer.from(publication))) {
      try { removeFailedPointer(ctx, spec.id, publication); }
      catch (cleanupError) { throw new AggregateError([e, cleanupError], report(`${spec.title}: install failed; pointer cleanup was incomplete; configuration rollback completed and backups are preserved`)); }
    }
    throw new SetupError(report(`${e instanceof Error ? e.message : String(e)}; tracked configuration rollback completed with unmanaged edits preserved; ${retained.length} unowned new paths retained; before backups: ${join(snap.dir, 'before')}`), { cause: e });
  }
}

function sameBytes(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  const before=safeRead(a),after=safeRead(b);
  if(before===null||after===null)throw new Error('snapshot backup is missing; refusing comparison');
  return before.equals(after);
}

export function uninstall(ctx: SetupContext, spec: RunnerSpec): string[] {
  return withSetupLock(join(ctx.setupDir, `${spec.id}.setup.lock`), () => uninstallLocked(ctx, spec));
}

export function uninstallLocked(ctx: SetupContext, spec: RunnerSpec): string[] {
  const ledger = installedLedger(ctx, spec.id, spec);
  if (!ledger) {
    const recovered = undoInterruptedInstall(ctx, spec);
    if (recovered.length) return recovered;
    throw new SetupError(`${spec.title}: not installed by Context Engine (no install record in ${ctx.setupDir})`);
  }
  // A record that fails validation refuses here, before any change, and not after the uninstall finished.
  const pending = interruptedInstall(ctx, spec);
  checkOwnedDirectory(spec.home);
  preflightOwnership(spec);
  const lines: string[] = [];
  for (const cmd of spec.uninstall) {
    const r = runBinary(spec.bin, cmd, ctx.env);
    if (!r.ok) lines.push(`\`${spec.bin} ${cmd.join(' ')}\` failed (${r.output.slice(0, 200)}); Context Engine's entries were removed directly instead`);
  }
  lines.push(...describe(revert(ledger, spec.rules, assess(ledger, spec.rules))));
  const parent = openPrivateDirectory(ctx.setupDir)!;
  try { unlinkSync(childTarget(anchor(parent), `${spec.id}.json`)); fsyncSync(parent); }
  finally { closeSync(parent); }
  // A kill between pointer publication and pending removal leaves this install's own pending record.
  if (pending?.dir === ledger.dir) removePending(ctx, spec.id);
  lines.push(`Backups kept: ${ledger.dir}`);
  if (ledger.retainedPaths?.length) lines.push(`Unowned new paths retained: ${ledger.retainedPaths.length}`);
  return lines;
}

export function describe(reports: FileReport[]): string[] {
  return reports.map((r) => {
    switch (r.outcome) {
      case 'restored':
        return `${r.path}: restored byte for byte`;
      case 'deleted':
        return `${r.path}: removed (it did not exist before install)`;
      case 'reverse-edited':
        return `${r.path}: changed by something else since install, so only Context Engine's entries were removed (not a byte-for-byte restore; the original is at ${r.backup ?? '(none: the file did not exist)'})`;
      case 'missing':
        return `${r.path}: missing now; left missing (the original is at ${r.backup ?? '(none)'})`;
      default:
        return `${r.path}: unchanged`;
    }
  });
}
