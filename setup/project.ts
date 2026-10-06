// Per-project enable/disable. The participation record (core/participation.ts) is what both
// adapters check. With the Codex adapter installed, enable also writes the project's Codex
// settings, because Codex has no per-project switch of its own for features.token_budget. They go
// into <project>/.codex/config.toml only (issue #8 amendment), as two marked blocks:
//
// - at the start, `developer_instructions`: static text written by us (adapters/codex/guidance.ts)
//   that points at the Working Context; a top-level key, so it must precede every table;
// - at the end, a [features.token_budget] table with Context Engine's guidance message.
//
// Codex reads that file only when the project is trusted. Keeping all of it per project (no
// AGENTS.md section, no global plugin skill, nothing in ~/.codex/config.toml) means Codex sessions
// in projects nobody enabled are unchanged: their prompt input is byte-for-byte what it would be
// without Context Engine installed, and they keep their normal compaction.
//
// The file is backed up byte for byte first and reverted by disable (or uninstall) as ledger.ts
// does. (Enables made before this change also wrote an AGENTS.md section; its rule stays so they
// revert cleanly.)
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { experimentOn, findRecord, killSwitchOn, participation, setParticipation } from '../core/index.ts';
import { projectKey } from '../core/store.ts';
import { projectCodexToml } from '../adapters/codex/guidance.ts';
import { describe, installedLedger } from './install.ts';
import { assess, completeLedger, readLedger, revert, takeSnapshot, type Rule } from './ledger.ts';
import { appendBlock, blockRule, prependBlock, type Markers } from './rules.ts';
import type { SetupContext } from './runners.ts';

export const TOML_MARKERS: Markers = {
  begin: '# >>> context-engine: written by `context-engine enable`; `context-engine disable` removes it',
  end: '# <<< context-engine',
};
/** The block at the start of the file (top-level keys). */
export const TOML_TOP_MARKERS: Markers = {
  begin: '# >>> context-engine (top-level keys): written by `context-engine enable`; `context-engine disable` removes it',
  end: '# <<< context-engine (top-level keys)',
};
/** Only for reverting enables made before the AGENTS.md section was dropped. */
export const MD_MARKERS: Markers = {
  begin: '<!-- >>> context-engine: written by `context-engine enable`; `context-engine disable` removes it -->',
  end: '<!-- <<< context-engine -->',
};

const codexConfig = (root: string) => join(root, '.codex', 'config.toml');
const agentsMd = (root: string) => join(root, 'AGENTS.md');
const projectsDir = (ctx: SetupContext) => join(ctx.setupDir, 'projects');
const pointer = (ctx: SetupContext, root: string) => join(projectsDir(ctx), `${projectKey(root)}.json`);

/** Both marked blocks of the project's .codex/config.toml. */
function codexConfigRule(): Rule {
  const top = blockRule(TOML_TOP_MARKERS);
  const table = blockRule(TOML_MARKERS);
  return { strip: (text, before) => table.strip(top.strip(text, before), before), canon: table.canon };
}

function projectRules(root: string): Record<string, Rule> {
  return { [codexConfig(root)]: codexConfigRule(), [agentsMd(root)]: blockRule(MD_MARKERS) };
}

/** Whether a TOML text sets `developer_instructions` at the top level (before its first table). */
function topLevelDeveloperInstructions(text: string): boolean {
  for (const line of text.split('\n')) {
    if (/^\s*\[/.test(line)) return false;
    if (/^\s*developer_instructions\s*=/.test(line)) return true;
  }
  return false;
}

/** Whether Context Engine's Codex settings are in the project's .codex/config.toml. */
export function codexProjectSettings(root: string): boolean {
  const p = codexConfig(root);
  return existsSync(p) && readFileSync(p, 'utf8').includes(TOML_MARKERS.begin);
}

/** Whether the user's Codex config trusts `root` or one of its parents (Codex ignores .codex/config.toml otherwise). */
export function codexTrusts(ctx: SetupContext, root: string): boolean {
  const p = join(ctx.codexHome, 'config.toml');
  if (!existsSync(p)) return false;
  const text = readFileSync(p, 'utf8');
  for (let dir = root; ; dir = dirname(dir)) {
    const at = text.indexOf(`[projects.${JSON.stringify(dir)}]`);
    if (at >= 0 && /^\s*trust_level\s*=\s*"trusted"/m.test(text.slice(at).split(/\n\s*\[/)[0]!)) return true;
    if (dirname(dir) === dir) return false;
  }
}

function writeCodexProjectFiles(ctx: SetupContext, root: string): string[] {
  if (existsSync(pointer(ctx, root))) return ['Codex: project settings already in place'];
  const config = codexConfig(root);
  const existing = existsSync(config) ? readFileSync(config, 'utf8') : null;
  if (existing !== null && /token_budget/.test(existing)) {
    return [`Codex: ${config} already configures token_budget, so it was left alone; Context Engine's Codex guidance is NOT in effect here`];
  }
  if (existing !== null && topLevelDeveloperInstructions(existing)) {
    return [`Codex: ${config} already sets developer_instructions, so it was left alone; Context Engine's Codex guidance is NOT in effect here`];
  }
  const snap = takeSnapshot({
    backupRoot: join(ctx.setupDir, 'backups'),
    kind: `project-${projectKey(root)}`,
    files: [config],
    watch: [join(root, '.codex')],
    namespaced: [],
    extra: { projectRoot: root },
  });
  const experiments = experimentOn('stale-refs') ? ['stale-refs'] : [];
  const toml = projectCodexToml({ experiments });
  mkdirSync(dirname(config), { recursive: true });
  writeFileSync(config, appendBlock(prependBlock(existing, toml.top, TOML_TOP_MARKERS), toml.table, TOML_MARKERS));
  const ledger = completeLedger(snap);
  mkdirSync(projectsDir(ctx), { recursive: true, mode: 0o700 });
  writeFileSync(pointer(ctx, root), `${JSON.stringify({ dir: ledger.dir, projectRoot: root })}\n`, { mode: 0o600 });
  const lines = [
    `Codex: wrote developer_instructions and [features.token_budget] to ${config} (byte backup: ${join(ledger.dir, 'before')}); nothing else, so other projects are unchanged`,
  ];
  if (!codexTrusts(ctx, root)) lines.push(`Codex: this project is not trusted in ${join(ctx.codexHome, 'config.toml')}, so Codex ignores ${config} until you trust it (Codex asks when it starts here)`);
  return lines;
}

/** Reverts the Codex project files of one project (by pointer file). */
function revertCodexProjectFiles(pointerFile: string): string[] {
  const { dir, projectRoot } = JSON.parse(readFileSync(pointerFile, 'utf8')) as { dir: string; projectRoot: string };
  const ledger = readLedger(dir);
  const rules = projectRules(projectRoot);
  const lines = describe(revert(ledger, rules, assess(ledger, rules)));
  unlinkSync(pointerFile);
  return lines;
}

/** Reverts every project's Codex files (uninstall --codex). */
export function revertAllCodexProjects(ctx: SetupContext): string[] {
  if (!existsSync(projectsDir(ctx))) return [];
  return readdirSync(projectsDir(ctx))
    .filter((f) => f.endsWith('.json'))
    .flatMap((f) => revertCodexProjectFiles(join(projectsDir(ctx), f)));
}

export function enableProject(ctx: SetupContext, projectRoot: string): string[] {
  setParticipation({ projectRoot, state: 'on' });
  const rec = findRecord({ projectRoot })!;
  const lines = [`Context Engine enabled for ${rec.project} and its subdirectories (new sessions).`];
  if (killSwitchOn(ctx.env)) lines.push('Note: the kill switch CONTEXT_ENGINE=off is set in this shell, so the adapters stay off where it is set.');
  if (installedLedger(ctx, 'codex')) lines.push(...writeCodexProjectFiles(ctx, rec.project));
  else lines.push('Codex: adapter not installed (`context-engine install --codex`).');
  return lines;
}

export function disableProject(ctx: SetupContext, projectRoot: string): string[] {
  setParticipation({ projectRoot, state: 'off' });
  const p = participation({ projectRoot, env: {} });
  const lines = [`Context Engine disabled for ${p.project} and its subdirectories (new sessions; a running Codex session stops at its next hook).`];
  const ptr = pointer(ctx, p.project!);
  if (existsSync(ptr)) lines.push(...revertCodexProjectFiles(ptr));
  return lines;
}
