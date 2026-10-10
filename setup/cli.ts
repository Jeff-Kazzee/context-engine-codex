// Setup commands for people: install, uninstall, enable, disable, status. Text output.
import { parseArgs } from 'node:util';
import { existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { acquireSetupLock } from './files.ts';
import { installedLedger, installLocked as install, interruptedInstall, refuseInterruptedInstall, uninstallLocked as uninstall } from './install.ts';
import { trustCodexHooks } from './codex-trust.ts';
import { disableProject, enableProject, revertAllCodexProjects } from './project.ts';
import { codexSpec, type RunnerSpec, setupContext } from './runners.ts';
import { CODEX_FLAG_NOTE, CODEX_LABEL, CODEX_TOKEN_LIMIT_LINE, statusText } from './status.ts';

const HELP = `context-engine-codex
  install [--codex] [--trust-hooks]
  uninstall [--codex]
  enable|disable|status [--project <dir>]
  status [--json]
Installs only codex; inert until enabled per project. Backups precede config changes.
Uninstall keeps session data. See README.md and adapters/codex/README.md.
`;

export async function runSetup(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  const { values } = parseArgs({
    args,
    options: {
      claude: { type: 'boolean' },
      codex: { type: 'boolean' },
      'trust-hooks': { type: 'boolean' },
      project: { type: 'string' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (values.claude) {
    process.stderr.write('This distribution supports codex only.\n');
    return 1;
  }
  const ctx = setupContext();
  const projectRoot = realpathSync(resolve(values.project ?? process.cwd()));
  const out = (lines: string[]) => process.stdout.write(`${lines.join('\n')}\n`);
  let release: (() => void) | undefined;
  try {
    if (['install', 'uninstall', 'enable', 'disable'].includes(command ?? '')) release = acquireSetupLock(join(ctx.setupDir, 'codex.setup.lock'));
    if (command === 'install' || command === 'uninstall') {
      const specs: RunnerSpec[] = [codexSpec(ctx)];
      let failed = false;
      for (const spec of specs) {
        try {
          if (command === 'install') {
            const lines = install(ctx, spec);
            const label = `${CODEX_LABEL}, ${CODEX_FLAG_NOTE}, in projects you enable (Codex must trust the project); ${CODEX_TOKEN_LIMIT_LINE}`;
            if (spec.id === 'codex') {
              if (values['trust-hooks']) {
                try { lines.push(...await trustCodexHooks(ctx, spec)); }
                catch (e) {
                  failed = true;
                  lines.push(`Hooks: trust could not be verified (${e instanceof Error ? e.message : String(e)}). Installation is retained. Review and approve the hooks with /hooks in Codex, then run context-engine-codex status. Do not retry install while this install record exists.`);
                }
              } else lines.push('Hooks: Codex runs plugin hooks only once trusted. Approve the five Context Engine hooks with /hooks in Codex (or uninstall and install again with --trust-hooks).');
            }
            out([`${spec.title}: installed. Delivery Mode: ${label}.`, ...lines.map((l) => `  ${l}`), '  Inert until `context-engine-codex enable` in a project (the pilot is opt-in).']);
          } else {
            // Project reverts belong to a recorded install. Without the record, uninstall leaves projects alone.
            // An interrupted install record that fails validation refuses before any project is reverted.
            const installed = spec.id === 'codex' && !!installedLedger(ctx, spec.id, spec);
            if (installed) interruptedInstall(ctx, spec);
            const lines = installed ? revertAllCodexProjects(ctx) : [];
            lines.push(...uninstall(ctx, spec));
            // Without an install record, a successful uninstall only undid an interrupted install.
            out([installed ? `${spec.title}: uninstalled.` : `${spec.title}: not installed. The interrupted install was rolled back.`, ...lines.map((l) => `  ${l}`)]);
          }
        } catch (e) {
          process.stderr.write(refusal(e));
          failed = true;
        }
      }
      return failed ? 1 : 0;
    }
    if (command === 'enable') {
      out(enableProject(ctx, projectRoot));
      return 0;
    }
    if (command === 'disable') {
      out(disableProject(ctx, projectRoot));
      return 0;
    }
    if (command === 'status') {
      // "Not installed" would hide a half-applied install, so status refuses until it is undone. Status
      // takes no lock. A live install holds the lock and its own record, so status checks the record only without a lock.
      if (!existsSync(join(ctx.setupDir, 'codex.setup.lock'))) refuseInterruptedInstall(ctx, codexSpec(ctx), false);
      const s = await statusText(ctx, projectRoot);
      process.stdout.write(values.json ? `${JSON.stringify(s.json)}\n` : `${s.lines.join('\n')}\n`);
      return 0;
    }
  } catch (e) {
    process.stderr.write(refusal(e));
    return 1;
  } finally { release?.(); }
  process.stderr.write(HELP);
  return 1;
}

/** People read setup refusals, so print the messages that name the paths, never a stack trace. */
function refusal(e: unknown): string {
  const text = (v: unknown) => (v instanceof Error ? v.message : String(v));
  const lines = [text(e)];
  if (e instanceof AggregateError) lines.push(...e.errors.map((inner) => `  ${text(inner)}`));
  else if (e instanceof Error && e.cause !== undefined && !lines[0]!.includes(text(e.cause))) lines.push(`  ${text(e.cause)}`);
  return `${lines.join('\n')}\n`;
}
