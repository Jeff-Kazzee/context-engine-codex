// Install and uninstall one runner's adapter through the runner's own plugin commands, with every
// config file they touch backed up byte for byte first (ledger.ts).
import { closeSync, existsSync, fsyncSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assess, completeLedger, type FileReport, type Ledger, readLedger, revert, rollbackSnapshot, takeSnapshot } from './ledger.ts';
import { safeRead, safeWrite, withSetupLock } from './files.ts';
import { openPrivateDirectory } from '../core/store.ts';
import { codexSpec, runBinary, type RunnerSpec, type SetupContext } from './runners.ts';

const pointerPath = (ctx: SetupContext, id: string) => join(ctx.setupDir, `${id}.json`);

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
  const prior = installedLedger(ctx, spec.id, spec);
  if (prior) throw new SetupError(`${spec.title}: already installed (${prior.at}); run \`context-engine-${spec.id} uninstall\` first`);
  const snap = takeSnapshot({ backupRoot: join(ctx.setupDir, 'backups'), kind: spec.id, files: spec.files, watch: spec.watch, namespaced: spec.namespaced });
  let publication: string | undefined;
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
    publication = `${JSON.stringify({ dir: ledger.dir })}\n`;
    safeWrite(pointerPath(ctx, spec.id), publication);
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
    // A rename may publish before its directory flush throws. Remove only our pointer.
    if (publication && safeRead(pointerPath(ctx, spec.id))?.equals(Buffer.from(publication))) {
      const parent = openPrivateDirectory(ctx.setupDir)!;
      try { unlinkSync(join(`/proc/self/fd/${parent}`, `${spec.id}.json`)); fsyncSync(parent); }
      finally { closeSync(parent); }
    }
    throw new SetupError(`${e instanceof Error ? e.message : String(e)}; tracked configuration rollback completed with unmanaged edits preserved; ${retained.length} unowned new paths retained; before backups: ${join(snap.dir, 'before')}`, { cause: e });
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
