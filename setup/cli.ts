// Setup commands for people: install, uninstall, enable, disable, status. Text output.
import { parseArgs } from 'node:util';
import { install, SetupError, uninstall } from './install.ts';
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
  const projectRoot = values.project ?? process.cwd();
  const out = (lines: string[]) => process.stdout.write(`${lines.join('\n')}\n`);
  try {
    if (command === 'install' || command === 'uninstall') {
      const specs: RunnerSpec[] = [codexSpec(ctx)];
      let failed = false;
      for (const spec of specs) {
        try {
          if (command === 'install') {
            const lines = install(ctx, spec);
            const label = `${CODEX_LABEL}, ${CODEX_FLAG_NOTE}, in projects you enable (Codex must trust the project); ${CODEX_TOKEN_LIMIT_LINE}`;
            if (spec.id === 'codex') {
              lines.push(
                ...(values['trust-hooks']
                  ? await trustCodexHooks(ctx, spec)
                  : ['Hooks: Codex runs plugin hooks only once trusted. Approve the five Context Engine hooks with /hooks in Codex (or uninstall and install again with --trust-hooks).']),
              );
            }
            out([`${spec.title}: installed. Delivery Mode: ${label}.`, ...lines.map((l) => `  ${l}`), '  Inert until `context-engine enable` in a project (the pilot is opt-in).']);
          } else {
            const lines = spec.id === 'codex' ? revertAllCodexProjects(ctx) : [];
            lines.push(...uninstall(ctx, spec));
            out([`${spec.title}: uninstalled.`, ...lines.map((l) => `  ${l}`)]);
          }
        } catch (e) {
          if (!(e instanceof SetupError)) throw e;
          process.stderr.write(`${e.message}\n`);
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
      const s = await statusText(ctx, projectRoot);
      process.stdout.write(values.json ? `${JSON.stringify(s.json)}\n` : `${s.lines.join('\n')}\n`);
      return 0;
    }
  } catch (e) {
    if (!(e instanceof SetupError)) throw e;
    process.stderr.write(`${e.message}\n`);
    return 1;
  }
  process.stderr.write(HELP);
  return 1;
}
