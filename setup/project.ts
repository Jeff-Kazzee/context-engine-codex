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
import { describe, installedLedger, SetupError } from './install.ts';
import { assess, completeLedger, readLedger, revert, rollbackSnapshot, takeSnapshot, type Ledger, type Rule } from './ledger.ts';
import { safeRead, safeWrite } from './files.ts';
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
const pointer = (ctx: SetupContext, root: string) => {
  const key = projectKey(root);
  return join(projectsDir(ctx), `${key.length <= 250 ? key : `${key.slice(0, 128)}-${key.slice(-64)}`}.json`);
};

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
  // Track multiline values so array elements and string contents cannot be mistaken
  // for table declarations. Only statement starts can introduce a top-level key.
  let quote = '', multiline = false, depth = 0, inTable = false;
  for (const line of text.split('\n')) {
    if (!quote && depth === 0) {
      if (/^\s*\[/.test(line)) {
        if (/"(?:[^"\\]|\\.)*\\(?:[^"\\]|\\.)*"/.test(line)) throw new SetupError('Codex: escaped quoted project TOML table keys are unsupported; configuration was left unchanged');
        inTable = true;
      }
      if (/^\s*"(?:[^"\\]|\\.)*\\(?:[^"\\]|\\.)*"\s*=/.test(line)) {
        throw new SetupError('Codex: escaped quoted project TOML keys are unsupported; configuration was left unchanged');
      }
      if (!inTable && /^\s*(?:developer_instructions|"developer_instructions"|'developer_instructions')\s*=/.test(line)) return true;
    }
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      if (quote) {
        if (quote === '"' && ch === '\\') { i++; continue; }
        if (ch === quote && (!multiline || line.slice(i, i + 3) === quote.repeat(3))) {
          if (multiline) {
            let end = i + 3;
            while (line[end] === quote) end++;
            if (end - i > 5) throw new SetupError('Codex: malformed project TOML quote sequence; configuration was left unchanged');
            i = end - 1;
          }
          quote = ''; multiline = false;
        }
        continue;
      }
      if (ch === '#') break;
      if (ch === '"' || ch === "'") {
        quote = ch; multiline = line.slice(i, i + 3) === ch.repeat(3);
        if (multiline) i += 2;
      } else if (ch === '[' || ch === '{') depth++;
      else if (ch === ']' || ch === '}') depth--;
    }
    if (depth < 0 || (quote && !multiline)) throw new SetupError('Codex: malformed project TOML; configuration was left unchanged');
  }
  if (quote || depth !== 0) throw new SetupError('Codex: incomplete project TOML; configuration was left unchanged');
  return false;
}

/** Whether Context Engine's Codex settings are in the project's .codex/config.toml. */
export function codexProjectSettings(root: string): boolean {
  const p = codexConfig(root);
  try {
    const text = safeRead(p)?.toString('utf8') ?? '';
    const expected = projectCodexToml({experiments:experimentOn('stale-refs') ? ['stale-refs'] : []});
    const matches = (m: Markers, body: string) => {
      const start = text.indexOf(m.begin+'\n'), stop = text.indexOf(m.end+'\n',start);
      return start >= 0 && stop > start && text.slice(start+m.begin.length+1,stop).trim() === body.trim();
    };
    return matches(TOML_TOP_MARKERS,expected.top) && matches(TOML_MARKERS,expected.table);
  } catch { return false; }
}

/** Whether the user's Codex config trusts `root` or one of its parents (Codex ignores .codex/config.toml otherwise). */
export function codexTrusts(ctx: SetupContext, root: string): boolean {
  const p = join(ctx.codexHome, 'config.toml');
  if (!existsSync(p)) return false;
  const text = safeRead(p)?.toString('utf8') ?? '';
  for (let dir = root; ; dir = dirname(dir)) {
    const at = text.indexOf(`[projects.${JSON.stringify(dir)}]`);
    if (at >= 0 && /^\s*trust_level\s*=\s*"trusted"/m.test(text.slice(at).split(/\n\s*\[/)[0]!)) return true;
    if (dirname(dir) === dir) return false;
  }
}

function writeCodexProjectFiles(ctx: SetupContext, root: string): string[] {
  const config = codexConfig(root);
  const existing = safeRead(config)?.toString('utf8') ?? null;
  const pointerBytes = safeRead(pointer(ctx,root));
  const old = pointerBytes ? readLedger(JSON.parse(pointerBytes.toString('utf8')).dir,{backupRoot:join(ctx.setupDir,'backups'),files:[config],namespaced:[]}) : null;
  if (!old && existing !== null && [TOML_MARKERS.begin, TOML_MARKERS.end, TOML_TOP_MARKERS.begin, TOML_TOP_MARKERS.end].some(marker => existing.includes(marker))) {
    throw new SetupError(`Codex: ${config} contains unowned Context Engine markers; configuration was left unchanged`);
  }
  if (old && codexProjectSettings(root)) return ['Codex: project settings already in place'];
  const unmanaged = existing === null ? null : codexConfigRule().strip(existing, old?.files[0]?.before ? readFileSync(old.files[0].before, 'utf8') : null);
  // Check actual table/key declarations, not comments or values containing the name.
  if (unmanaged !== null && /^\s*(?:\[\s*(?:features|"features"|'features')\s*\.\s*(?:token_budget|"token_budget"|'token_budget')\s*\]|(?:(?:features|"features"|'features')\s*\.\s*)?(?:token_budget|"token_budget"|'token_budget')\s*=)/m.test(unmanaged)) {
    throw new SetupError(`Codex: ${config} already configures token_budget; Context Engine guidance was not activated`);
  }
  if (unmanaged !== null && topLevelDeveloperInstructions(unmanaged)) {
    throw new SetupError(`Codex: ${config} already sets developer_instructions; Context Engine guidance was not activated`);
  }
  const snap = takeSnapshot({
    backupRoot: join(ctx.setupDir, 'backups'),
    kind: `project-${projectKey(root).slice(-64)}`,
    files: [config],
    watch: [join(root, '.codex')],
    namespaced: [],
    extra: { projectRoot: root },
  });
  const experiments = experimentOn('stale-refs') ? ['stale-refs'] : [];
  const toml = projectCodexToml({ experiments });
  let ledger: Ledger;
  try {
    safeWrite(config, appendBlock(prependBlock(unmanaged, toml.top, TOML_TOP_MARKERS), toml.table, TOML_MARKERS));
    ledger = completeLedger(snap);
    // A repair must retain changes made since the initial enable. Keep the old
    // rollback bytes only when the currently unmanaged text still matches them.
    if (old) {
      ledger.files = ledger.files.map((f, i) => {
        if (unmanaged === null) return { ...f, before: null };
        const previous = old.files.find(o => o.path === f.path)?.before ?? null;
        const previousText = previous ? readFileSync(previous, 'utf8') : '';
        if (unmanaged === previousText) return { ...f, before: previous };
        const repairBefore = join(ledger.dir, 'before', `repair-unmanaged-${i}`);
        safeWrite(repairBefore, unmanaged ?? '');
        return { ...f, before: repairBefore };
      });
      safeWrite(join(ledger.dir, 'ledger.json'), `${JSON.stringify(ledger, null, 2)}\n`);
    }
    mkdirSync(projectsDir(ctx), { recursive: true, mode: 0o700 });
    safeWrite(pointer(ctx, root), `${JSON.stringify({ dir: ledger.dir, projectRoot: root })}\n`);
  } catch (e) {
    rollbackSnapshot(snap, projectRules(root));
    throw new SetupError(`Codex project setup failed and was rolled back: ${e instanceof Error ? e.message : String(e)}`);
  }
  const lines = [
    `Codex: wrote developer_instructions and [features.token_budget] to ${config} (byte backup: ${join(ledger.dir, 'before')}); nothing else, so other projects are unchanged`,
  ];
  if (!codexTrusts(ctx, root)) lines.push(`Codex: this project is not trusted in ${join(ctx.codexHome, 'config.toml')}, so Codex ignores ${config} until you trust it (Codex asks when it starts here)`);
  return lines;
}

/** Reverts the Codex project files of one project (by pointer file). */
function revertCodexProjectFiles(ctx: SetupContext, pointerFile: string): string[] {
  const { dir, projectRoot } = JSON.parse(safeRead(pointerFile)!.toString('utf8')) as { dir: string; projectRoot: string };
  if (typeof projectRoot !== 'string' || pointer(ctx, projectRoot) !== pointerFile) throw new SetupError('project ledger pointer violates confinement policy');
  const ledger = readLedger(dir,{backupRoot:join(ctx.setupDir,'backups'),files:[codexConfig(projectRoot)],namespaced:[]});
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
    .flatMap((f) => revertCodexProjectFiles(ctx,join(projectsDir(ctx), f)));
}

export function enableProject(ctx: SetupContext, projectRoot: string): string[] {
  let setupLines: string[];
  try { setupLines = installedLedger(ctx, 'codex') ? writeCodexProjectFiles(ctx, projectRoot) : ['Codex: adapter not installed (`context-engine-codex install --codex`).']; }
  catch (e) {
    // An inherited/previous opt-in must not leave hooks active after setup fails.
    setParticipation({ projectRoot, state: 'off' });
    throw e;
  }
  setParticipation({ projectRoot, state: 'on' });
  const rec = findRecord({ projectRoot })!;
  const lines = [`Context Engine enabled for ${rec.project} and its subdirectories (new sessions).`];
  if (killSwitchOn(ctx.env)) lines.push('Note: the kill switch CONTEXT_ENGINE=off is set in this shell, so the adapters stay off where it is set.');
  lines.push(...setupLines);
  return lines;
}

export function disableProject(ctx: SetupContext, projectRoot: string): string[] {
  setParticipation({ projectRoot, state: 'off' });
  const p = participation({ projectRoot, env: {} });
  const lines = [`Context Engine disabled for ${p.project} and its subdirectories (new sessions; a running Codex session stops at its next hook).`];
  const ptr = pointer(ctx, p.project!);
  if (existsSync(ptr)) lines.push(...revertCodexProjectFiles(ctx,ptr));
  return lines;
}
