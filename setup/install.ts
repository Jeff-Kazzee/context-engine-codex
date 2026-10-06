// Install and uninstall one runner's adapter through the runner's own plugin commands, with every
// config file they touch backed up byte for byte first (ledger.ts).
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assess, completeLedger, type FileReport, type Ledger, readLedger, revert, rollbackSnapshot, takeSnapshot } from './ledger.ts';
import { safeRead, safeWrite, withSetupLock } from './files.ts';
import { runBinary, type RunnerSpec, type SetupContext } from './runners.ts';

const pointerPath = (ctx: SetupContext, id: string) => join(ctx.setupDir, `${id}.json`);

/** The install ledger of a runner, or null when Context Engine isn't installed there. */
export function installedLedger(ctx: SetupContext, id: string): Ledger | null {
  const p = pointerPath(ctx, id);
  const bytes = safeRead(p);
  if (bytes === null) return null;
  return readLedger(JSON.parse(bytes.toString('utf8')).dir);
}

export class SetupError extends Error {}

export function install(ctx: SetupContext, spec: RunnerSpec): string[] {
  return withSetupLock(join(ctx.setupDir, `${spec.id}.setup.lock`), () => installLocked(ctx, spec));
}

export function installLocked(ctx: SetupContext, spec: RunnerSpec): string[] {
  const prior = installedLedger(ctx, spec.id);
  if (prior) throw new SetupError(`${spec.title}: already installed (${prior.at}); run \`context-engine-${spec.id} uninstall\` first`);
  const snap = takeSnapshot({ backupRoot: join(ctx.setupDir, 'backups'), kind: spec.id, files: spec.files, watch: spec.watch, namespaced: spec.namespaced });
  let published = false;
  try {
    spec.prepare?.();
    for (const cmd of spec.install) {
      const r = runBinary(spec.bin, cmd, ctx.env);
      if (!r.ok) {
        // The transaction catch restores tracked configuration on any failure.
        throw new SetupError(`${spec.title}: \`${spec.bin} ${cmd.join(' ')}\` failed: ${r.output.slice(0, 500)}`);
      }
    }
    const ledger = completeLedger(snap);
    mkdirSync(ctx.setupDir, { recursive: true, mode: 0o700 });
    safeWrite(pointerPath(ctx, spec.id), `${JSON.stringify({ dir: ledger.dir })}\n`);
    published = true;
    const changed = ledger.files.filter((f) => !sameBytes(f.before, f.after)).map((f) => f.path);
    return [
      `Changed by \`${spec.bin} plugin\`: ${changed.join(', ') || '(no config file)'}`,
      `Byte backups taken before the change: ${join(ledger.dir, 'before')}`,
      `New paths outside Context Engine namespaces retained: ${ledger.retainedPaths?.length ?? 0} (ownership unverified; uninstall will leave them alone)`,
    ];
  } catch (e) {
    let retained: string[];
    try { retained = rollbackSnapshot(snap, spec.rules); }
    catch (rollbackError) { throw new AggregateError([e, rollbackError], `${spec.title}: install failed and rollback was incomplete; before backups are preserved at ${join(snap.dir, 'before')}`); }
    if (published) try { unlinkSync(pointerPath(ctx, spec.id)); } catch (cleanupError) { if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') throw cleanupError; }
    throw new SetupError(`${e instanceof Error ? e.message : String(e)}; tracked configuration rollback completed with unmanaged edits preserved; ${retained.length} unowned new paths retained; before backups: ${join(snap.dir, 'before')}`, { cause: e });
  }
}

function sameBytes(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return readFileSync(a).equals(readFileSync(b));
}

export function uninstall(ctx: SetupContext, spec: RunnerSpec): string[] {
  return withSetupLock(join(ctx.setupDir, `${spec.id}.setup.lock`), () => uninstallLocked(ctx, spec));
}

export function uninstallLocked(ctx: SetupContext, spec: RunnerSpec): string[] {
  const ledger = installedLedger(ctx, spec.id);
  if (!ledger) throw new SetupError(`${spec.title}: not installed by Context Engine (no install record in ${ctx.setupDir})`);
  const lines: string[] = [];
  for (const cmd of spec.uninstall) {
    const r = runBinary(spec.bin, cmd, ctx.env);
    if (!r.ok) lines.push(`\`${spec.bin} ${cmd.join(' ')}\` failed (${r.output.slice(0, 200)}); Context Engine's entries were removed directly instead`);
  }
  lines.push(...describe(revert(ledger, spec.rules, assess(ledger, spec.rules))));
  unlinkSync(pointerPath(ctx, spec.id));
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
