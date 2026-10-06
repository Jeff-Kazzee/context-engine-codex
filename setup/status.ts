// `context-engine status`: what is installed, which Delivery Mode each runner gets, and whether
// it applies to this project. Every mode is printed with its exact label and granularity.
//
// Codex: the token_budget path is reported only when it is in effect for the project: Context
// Engine is enabled here, the project's .codex/config.toml carries our settings, Codex trusts the
// project, the plugin is enabled with all five hooks trusted, and Codex's own rendering of the
// prompt input (`codex debug prompt-input`, offline, no model call) carries Context Engine's
// token_budget guidance. Otherwise the Codex line says "inactive here" and why. The per-user-turn
// path (the turn loop) is never switched to automatically: it is a separate command.
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { CODEX_TOKEN_LIMIT_RESET, KILL_SWITCH_ENV, killSwitchOn, participation } from '../core/index.ts';
import { GUIDANCE_PROBE, RESET_MODE } from '../adapters/codex/guidance.ts';
import { MODE as TURN_LOOP_MODE } from '../adapters/codex/turn-loop/turn-loop.ts';
import { installedLedger } from './install.ts';
import { safeRead } from './files.ts';
import { currentCodexTrust } from './codex-trust.ts';
import { codexProjectSettings, codexTrusts } from './project.ts';
import { CODEX_HOOK_COUNT, CODEX_PLUGIN_ID, codexSpec, runBinary, type SetupContext } from './runners.ts';

export const CODEX_LABEL = RESET_MODE.label;
export const CODEX_FLAG_NOTE = 'through features.token_budget (an UnderDevelopment Codex flag)';
/** How a reset Codex makes on its own (its token-limit backstop, a manual /compact) is labelled: the runner compacting. */
export const CODEX_TOKEN_LIMIT_LINE = `Resets from Codex's own token limit: ${CODEX_TOKEN_LIMIT_RESET.label}`;
const KNOWN_EXPERIMENTS = ['stale-refs'];

function codexTrustEntries(ctx: SetupContext): number {
  const p = join(ctx.codexHome, 'config.toml');
  if (!existsSync(p)) return 0;
  const prefix = `[hooks.state."${CODEX_PLUGIN_ID}:`;
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.trim().startsWith(prefix)).length;
}

/** Whether ~/.codex/config.toml enables the Context Engine plugin. */
function codexPluginEnabled(ctx: SetupContext): boolean {
  const p = join(ctx.codexHome, 'config.toml');
  if (!existsSync(p)) return false;
  const text = safeRead(p)?.toString('utf8') ?? '';
  const at = text.indexOf(`[plugins.${JSON.stringify(CODEX_PLUGIN_ID)}]`);
  return at >= 0 && /^\s*enabled\s*=\s*true/m.test(text.slice(at).split(/\n\s*\[/)[0]!);
}

/**
 * Asks Codex itself whether the token_budget path is in effect in `root`: `codex debug
 * prompt-input` renders the model-visible input offline (no model call, no login needed), and
 * Context Engine's guidance is in it only when Codex applied the project's token_budget settings.
 */
export function probeCodexGuidance(ctx: SetupContext, root: string): { seen: boolean; detail: string } {
  const r = runBinary(codexSpec(ctx).bin, ['debug', 'prompt-input', '-c', 'suppress_unstable_features_warning=true', 'status check'], ctx.env, { cwd: root, timeoutMs: 60_000 });
  if (!r.ok) return { seen: false, detail: `\`codex debug prompt-input\` failed: ${r.output.slice(0, 200)}` };
  let texts: string[];
  try {
    const items = JSON.parse(r.stdout.slice(r.stdout.indexOf('['))) as Array<{ content?: Array<{ text?: unknown }> }>;
    texts = items.flatMap((i) => (i.content ?? []).map((c) => String(c.text ?? '')));
  } catch {
    return { seen: false, detail: '`codex debug prompt-input` printed no prompt input' };
  }
  return texts.some((t) => t.includes(GUIDANCE_PROBE))
    ? { seen: true, detail: 'Context Engine guidance seen in `codex debug prompt-input`' }
    : { seen: false, detail: "`codex debug prompt-input` shows no Context Engine token_budget guidance (the flag is off, changed, or overridden)" };
}

/** Where `context-engine` resolves on PATH, or null. */
function onPath(env: NodeJS.ProcessEnv): string | null {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    const p = join(dir, 'context-engine-codex');
    if (dir && existsSync(p)) return p;
  }
  return null;
}

export async function statusText(ctx: SetupContext, projectRoot: string): Promise<{ lines: string[]; json: Record<string, unknown> }> {
  const p = participation({ projectRoot, env: ctx.env });
  const experiments = (ctx.env.CONTEXT_ENGINE_EXPERIMENTS ?? '')
    .split(',')
    .map((e) => e.trim())
    .filter((e) => KNOWN_EXPERIMENTS.includes(e));
  const enabledLine =
    p.state === 'on' ? `enabled (${p.project})` : p.state === 'off' ? `disabled (${p.project})` : 'not enabled (the pilot is opt-in: `context-engine enable`)';
  const lines = [
    `Context Engine (checkout ${ctx.checkout})`,
    `Project: ${projectRoot}: ${enabledLine}`,
    `Kill switch: ${killSwitchOn(ctx.env) ? `ON (${KILL_SWITCH_ENV}=${ctx.env[KILL_SWITCH_ENV]}): both adapters are off` : `off (set ${KILL_SWITCH_ENV}=off to turn both adapters off)`}`,
    `Experiments: ${experiments.length ? experiments.join(', ') : 'none'} (CONTEXT_ENGINE_EXPERIMENTS; available: ${KNOWN_EXPERIMENTS.join(', ')})`,
    `CLI on PATH: ${onPath(ctx.env) ?? `no (agents call \`context-engine recall\` from their shell: run \`npm link\` in ${ctx.checkout})`}`,
    '',
  ];
  const here = (extra?: string) => (p.active ? (extra ? `no delivery here: ${extra}` : 'active here') : `inert here: ${p.reason}`);

  const codex = installedLedger(ctx, 'codex');
  const settingsRoot = p.project ?? projectRoot;
  const hasSettings = codexProjectSettings(settingsRoot);
  const trusted = codexTrusts(ctx, settingsRoot);
  const trust = codex ? await currentCodexTrust(ctx, codexSpec(ctx)) : 0;
  const pluginOn = codex ? codexPluginEnabled(ctx) : false;
  lines.push(`Codex: ${codex ? `installed ${codex.at} (${ctx.codexHome})` : 'not installed'}`);
  let codexInactive: string | undefined;
  let probe: { seen: boolean; detail: string } | null = null;
  if (codex) {
    if (!p.active) codexInactive = p.reason;
    else if (!hasSettings) codexInactive = `${join(settingsRoot, '.codex', 'config.toml')} has no Context Engine settings (run \`context-engine enable\` again)`;
    else if (!trusted) codexInactive = `Codex does not trust ${settingsRoot}, so it ignores the project's .codex/config.toml`;
    else if (!pluginOn) codexInactive = `the Context Engine plugin is not enabled in ${join(ctx.codexHome, 'config.toml')}`;
    else if (trust < CODEX_HOOK_COUNT) codexInactive = `only ${trust}/${CODEX_HOOK_COUNT} plugin hooks are trusted (untrusted hooks do not run: approve them with /hooks in Codex, or reinstall with --trust-hooks)`;
    else {
      probe = probeCodexGuidance(ctx, settingsRoot);
      if (!probe.seen) codexInactive = probe.detail;
    }
    lines.push(codexInactive ? `  Delivery Mode: inactive here (${codexInactive})` : `  Delivery Mode: ${CODEX_LABEL}, ${CODEX_FLAG_NOTE}`);
    lines.push(codexInactive ? `  Per-user-turn path: \`context-engine-codex-turns\` (${TURN_LOOP_MODE}); a separate headless command, not started for you` : `  active here (${probe!.detail})`);
    if (!codexInactive) lines.push(`  ${CODEX_TOKEN_LIMIT_LINE}`);
    lines.push(`  Hooks: ${trust}/${CODEX_HOOK_COUNT} trust entries verified against current hooks/list hashes`);
  }
  lines.push(`Headless Codex turn loop (context-engine-codex-turns): Delivery Mode: ${TURN_LOOP_MODE}`);
  return {
    lines,
    json: {
      project: projectRoot,
      participation: p,
      killSwitch: killSwitchOn(ctx.env),
      experiments,
      codex: codex
        ? {
            installed: codex.at,
            mode: codexInactive ? 'inactive' : CODEX_LABEL,
            tokenLimitResetMode: codexInactive ? null : CODEX_TOKEN_LIMIT_RESET.label,
            active: !codexInactive,
            problem: codexInactive ?? null,
            projectSettings: hasSettings,
            projectTrusted: trusted,
            pluginEnabled: pluginOn,
            hookTrustEntries: trust,
            guidanceSeen: probe?.seen ?? null,
          }
        : null,
      turnLoop: { mode: TURN_LOOP_MODE },
    },
  };
}
