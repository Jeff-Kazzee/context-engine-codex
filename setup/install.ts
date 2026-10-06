// Install and uninstall one runner's adapter through the runner's own plugin commands, with every
// config file they touch backed up byte for byte first (ledger.ts).
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assess, completeLedger, type FileReport, type Ledger, readLedger, revert, takeSnapshot } from './ledger.ts';
import { runBinary, type RunnerSpec, type SetupContext } from './runners.ts';

const pointerPath = (ctx: SetupContext, id: string) => join(ctx.setupDir, `${id}.json`);

/** The install ledger of a runner, or null when Context Engine isn't installed there. */
export function installedLedger(ctx: SetupContext, id: string): Ledger | null {
  const p = pointerPath(ctx, id);
  if (!existsSync(p)) return null;
  return readLedger(JSON.parse(readFileSync(p, 'utf8')).dir);
}

export class SetupError extends Error {}

export function install(ctx: SetupContext, spec: RunnerSpec): string[] {
  const prior = installedLedger(ctx, spec.id);
  if (prior) throw new SetupError(`${spec.title}: already installed (${prior.at}); run \`context-engine uninstall --${spec.id}\` first`);
  const snap = takeSnapshot({ backupRoot: join(ctx.setupDir, 'backups'), kind: spec.id, files: spec.files, watch: spec.watch, namespaced: spec.namespaced });
  spec.prepare?.();
  for (const cmd of spec.install) {
    const r = runBinary(spec.bin, cmd, ctx.env);
    if (!r.ok) {
      // Roll back to exactly what was there before.
      const l = completeLedger(snap);
      revert(l, spec.rules, Object.fromEntries(l.files.map((f) => [f.path, true])));
      throw new SetupError(`${spec.title}: \`${spec.bin} ${cmd.join(' ')}\` failed, so nothing was installed and every file was put back: ${r.output.slice(0, 500)}`);
    }
  }
  const ledger = completeLedger(snap);
  mkdirSync(ctx.setupDir, { recursive: true, mode: 0o700 });
  writeFileSync(pointerPath(ctx, spec.id), `${JSON.stringify({ dir: ledger.dir })}\n`, { mode: 0o600 });
  const changed = ledger.files.filter((f) => !sameBytes(f.before, f.after)).map((f) => f.path);
  return [
    `Changed by \`${spec.bin} plugin\`: ${changed.join(', ') || '(no config file)'}`,
    `Byte backups taken before the change: ${join(ledger.dir, 'before')}`,
  ];
}

function sameBytes(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return readFileSync(a).equals(readFileSync(b));
}

export function uninstall(ctx: SetupContext, spec: RunnerSpec): string[] {
  const ledger = installedLedger(ctx, spec.id);
  if (!ledger) throw new SetupError(`${spec.title}: not installed by Context Engine (no install record in ${ctx.setupDir})`);
  const unchanged = assess(ledger, spec.rules);
  const lines: string[] = [];
  for (const cmd of spec.uninstall) {
    const r = runBinary(spec.bin, cmd, ctx.env);
    if (!r.ok) lines.push(`\`${spec.bin} ${cmd.join(' ')}\` failed (${r.output.slice(0, 200)}); Context Engine's entries were removed directly instead`);
  }
  lines.push(...describe(revert(ledger, spec.rules, unchanged)));
  unlinkSync(pointerPath(ctx, spec.id));
  lines.push(`Backups kept: ${ledger.dir}`);
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
