// Setup lifecycle through the CLI: install, enable, status, disable, uninstall. Runner homes are
// scratch dirs and the runner binaries are fakes that reproduce the side effects measured on the
// real `claude plugin` / `codex plugin` commands (setup/testing/). The real binaries are checked
// on demand by regression/setup/run.ts.
import { test as nodeTest } from 'node:test';
const test = nodeTest;
// Only explicitly marked sibling-runtime cases skip; new/shared tests execute by default.
const otherRuntimeTest: typeof nodeTest = ((name: string) => nodeTest(name, {skip: 'Claude-only inherited case: covered in its runtime distribution'}, () => {})) as typeof nodeTest;
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tempDir } from '../core/testing.ts';
import { FAKE_CODEX, tree, world } from './testing/world.ts';

const SETTINGS = '{"theme": "dark",\n  "env": {"FOO": "1"}}\n';

otherRuntimeTest('Claude Code: install adds both plugins; uninstall leaves the config dir byte-identical', () => {
  const w = world();
  writeFileSync(join(w.claudeHome, 'settings.json'), SETTINGS);
  const before = tree(w.claudeHome);

  const inst = w.ce(['install', '--claude']);
  assert.equal(inst.status, 0, inst.stdout + inst.stderr);
  const settings = JSON.parse(readFileSync(join(w.claudeHome, 'settings.json'), 'utf8'));
  assert.equal(settings.enabledPlugins['context-engine@context-engine'], true);
  assert.equal(settings.enabledPlugins['context-engine-trigger@context-engine'], true);
  assert.match(inst.stdout, /settings\.json/);
  assert.match(inst.stdout, /backup/i);
  // The byte backup of settings.json is kept under the state dir, timestamped.
  const backups = join(w.stateDir, 'setup', 'backups');
  const [dir] = readdirSync(backups).filter((d) => d.startsWith('claude-'));
  assert.match(dir!, /^claude-\d{8}T\d{6}/);
  assert.ok(readdirSync(join(backups, dir!, 'before')).some((f) => readFileSync(join(backups, dir!, 'before', f), 'utf8') === SETTINGS));

  const un = w.ce(['uninstall', '--claude']);
  assert.equal(un.status, 0, un.stdout + un.stderr);
  assert.deepEqual(tree(w.claudeHome), before);
  assert.match(un.stdout, /restored/i);
});

otherRuntimeTest('Claude Code: a settings change made after install is kept; only Context Engine entries are removed, and that is reported', () => {
  const w = world();
  writeFileSync(join(w.claudeHome, 'settings.json'), SETTINGS);
  assert.equal(w.ce(['install', '--claude']).status, 0);
  const path = join(w.claudeHome, 'settings.json');
  const s = JSON.parse(readFileSync(path, 'utf8'));
  s.model = 'opus';
  writeFileSync(path, JSON.stringify(s, null, 2));

  const un = w.ce(['uninstall', '--claude']);
  assert.equal(un.status, 0, un.stderr);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { env: { FOO: '1' }, model: 'opus', theme: 'dark' }, 'no empty enabledPlugins/extraKnownMarketplaces left');
  assert.match(un.stdout, /settings\.json: changed by something else since install, so only Context Engine's entries were removed/);
  assert.equal(existsSync(join(w.claudeHome, 'plugins', 'cache', 'context-engine')), false);
});

const CODEX_CONFIG = '# my codex config\nmodel = "gpt-6-luna" # inline\n\n[projects."/tmp/x"]\ntrust_level = "trusted"\n';
const HOOK_EVENTS = ['pre_tool_use', 'post_tool_use', 'pre_compact', 'user_prompt_submit', 'stop'];
/** What approving the hooks in Codex's /hooks writes to config.toml (measured on codex-cli 0.160.0). */
function trustAll(w: ReturnType<typeof world>): void {
  const path = join(w.codexHome, 'config.toml');
  const tables = HOOK_EVENTS.map((e) => `\n[hooks.state."context-engine@context-engine:hooks/hooks.json:${e}:0:0"]\ntrusted_hash = "sha256:${e.padEnd(64, '0')}"\n`);
  writeFileSync(path, readFileSync(path, 'utf8') + tables.join(''));
}

test('Codex: install, trust the hooks, uninstall: config bytes restore exactly; unowned empty cache parents remain', () => {
  const w = world();
  writeFileSync(join(w.codexHome, 'config.toml'), CODEX_CONFIG);
  const before = tree(w.codexHome);
  const inst = w.ce(['install', '--codex']);
  assert.equal(inst.status, 0, inst.stdout + inst.stderr);
  const config = readFileSync(join(w.codexHome, 'config.toml'), 'utf8');
  assert.match(config, /\[plugins\."context-engine@context-engine"\]/);
  assert.ok(config.startsWith(CODEX_CONFIG));
  // The installed hook commands call this checkout's CLI.
  const hooks = readFileSync(join(w.codexHome, 'plugins', 'cache', 'context-engine', 'context-engine', '0.1.5', 'hooks', 'hooks.json'), 'utf8');
  assert.match(hooks, /CONTEXT_ENGINE_CLI='[^']*\/core\/cli\.ts' '[^']*node' \\"\$PLUGIN_ROOT\/hooks\/codex-hook\.ts\\"/);
  assert.match(inst.stdout, /\/hooks/, 'tells the user the hooks need trust');
  trustAll(w);

  const un = w.ce(['uninstall', '--codex']);
  assert.equal(un.status, 0, un.stdout + un.stderr);
  assert.equal(readFileSync(join(w.codexHome, 'config.toml'), 'utf8'), CODEX_CONFIG);
  assert.deepEqual(tree(w.codexHome), { ...before, '.tmp/': 'dir', '.tmp/marketplaces/': 'dir', 'plugins/': 'dir', 'plugins/cache/': 'dir' });
  assert.equal(existsSync(join(w.stateDir, 'setup', 'codex-marketplace')), false);
});

test('Codex: a config change made after install is kept; our tables and hook trust entries are removed', () => {
  const w = world();
  writeFileSync(join(w.codexHome, 'config.toml'), CODEX_CONFIG);
  assert.equal(w.ce(['install', '--codex']).status, 0);
  trustAll(w);
  const path = join(w.codexHome, 'config.toml');
  writeFileSync(path, readFileSync(path, 'utf8').replace('model = "gpt-6-luna"', 'model = "gpt-6.1-sol"'));
  const un = w.ce(['uninstall', '--codex']);
  assert.equal(un.status, 0, un.stderr);
  assert.equal(readFileSync(path, 'utf8'), CODEX_CONFIG.replace('gpt-6-luna', 'gpt-6.1-sol'));
  assert.match(un.stdout, /config\.toml: changed by something else since install/);
});

otherRuntimeTest('a failing runner command rolls the install back to the exact prior bytes', () => {
  const w = world();
  writeFileSync(join(w.claudeHome, 'settings.json'), SETTINGS);
  const before = tree(w.claudeHome);
  const r = w.ce(['install', '--claude'], { env: { FAKE_CLAUDE_FAIL: 'plugin install' } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /failed, so nothing was installed/);
  assert.deepEqual(tree(w.claudeHome), before);
  assert.equal(w.ce(['install', '--claude']).status, 0, 'and a later install works');
});

otherRuntimeTest('install refuses to run twice; uninstall of something not installed says so', () => {
  const w = world();
  assert.equal(w.ce(['install', '--claude']).status, 0);
  const again = w.ce(['install', '--claude']);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /already installed/);
  const none = w.ce(['uninstall', '--codex']);
  assert.equal(none.status, 1);
  assert.match(none.stderr, /not installed/);
});

test('--trust-hooks trusts exactly the five Context Engine hooks through the app-server; uninstall still restores the bytes', () => {
  const w = world();
  writeFileSync(join(w.codexHome, 'config.toml'), CODEX_CONFIG);
  const inst = w.ce(['install', '--codex', '--trust-hooks']);
  assert.equal(inst.status, 0, inst.stdout + inst.stderr);
  assert.match(inst.stdout, /Hooks: 5\/5 trusted/);
  assert.equal(readFileSync(join(w.codexHome, 'config.toml'), 'utf8').match(/^\[hooks\.state\."context-engine@context-engine:/gm)?.length, 5);
  assert.match(w.ce(['status']).stdout, /Hooks: 5\/5 trust entries/);
  assert.equal(w.ce(['uninstall', '--codex']).status, 0);
  assert.equal(readFileSync(join(w.codexHome, 'config.toml'), 'utf8'), CODEX_CONFIG);
});

const AGENTS = '# Project rules\n\nUse tabs.\n';
const PROJECT_CODEX = '# project codex settings\nmodel = "gpt-6-luna"\n\n[features]\nmulti_agent = false\n';
const RESET_LABEL = 'Full Replacement at agent-initiated resets (any model step); history grows between resets';
const reEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('enable with Codex installed writes only the project .codex/config.toml (static developer_instructions + token_budget); AGENTS.md is untouched; disable restores it byte for byte', () => {
  const w = world();
  assert.equal(w.ce(['install', '--codex']).status, 0);
  writeFileSync(join(w.project, 'AGENTS.md'), AGENTS);
  mkdirSync(join(w.project, '.codex'));
  writeFileSync(join(w.project, '.codex', 'config.toml'), PROJECT_CODEX);
  const before = tree(w.project);

  const en = w.ce(['enable']);
  assert.equal(en.status, 0, en.stdout + en.stderr);
  const toml = readFileSync(join(w.project, '.codex', 'config.toml'), 'utf8');
  // developer_instructions is a top-level key: it must come before every table, ours or the user's.
  const firstTable = toml.search(/^\[/m);
  const di = toml.search(/^developer_instructions = "Context Engine \(/m);
  assert.ok(di >= 0 && di < firstTable, toml);
  assert.ok(toml.includes(PROJECT_CODEX), 'the user file is kept whole between our blocks');
  assert.match(toml, new RegExp(`^\\[features\\.token_budget\\]\\nenabled = true\\nguidance_message = "Context Engine manages this context window \\(${reEscape(RESET_LABEL)}\\)`, 'm'));
  assert.match(toml, /^reminder_threshold_tokens = 6144$/m);
  assert.equal(readFileSync(join(w.project, 'AGENTS.md'), 'utf8'), AGENTS, 'AGENTS.md is never written');
  assert.match(en.stdout, /not trusted/, 'Codex ignores project config until the project is trusted');

  const dis = w.ce(['disable']);
  assert.equal(dis.status, 0, dis.stdout + dis.stderr);
  assert.deepEqual(tree(w.project), before, '.codex/config.toml byte-identical, AGENTS.md untouched');
});

test('enable with no project config creates .codex/config.toml; disable removes it and retains the unowned parent directory', () => {
  const w = world();
  assert.equal(w.ce(['install', '--codex']).status, 0);
  const before = tree(w.project);
  assert.equal(w.ce(['enable']).status, 0);
  const toml = readFileSync(join(w.project, '.codex', 'config.toml'), 'utf8');
  assert.ok(toml.indexOf('developer_instructions') < toml.indexOf('[features.token_budget]'));
  assert.equal(w.ce(['disable']).status, 0);
  assert.deepEqual(tree(w.project), { ...before, '.codex/': 'dir' });
});

test('enable leaves a project .codex/config.toml that already sets token_budget or developer_instructions alone, and says so', () => {
  for (const own of ['[features]\ntoken_budget = false\n', 'developer_instructions = "mine"\n\n[features]\nmulti_agent = false\n']) {
    const w = world();
    assert.equal(w.ce(['install', '--codex']).status, 0);
    mkdirSync(join(w.project, '.codex'));
    writeFileSync(join(w.project, '.codex', 'config.toml'), own);
    const en = w.ce(['enable']);
    assert.equal(en.status, 1);
    assert.match(en.stderr, /already (configures token_budget|sets developer_instructions)/);
    assert.equal(readFileSync(join(w.project, '.codex', 'config.toml'), 'utf8'), own);
    assert.equal(JSON.parse(w.ce(['status', '--json']).stdout).participation.active, false);
  }
});

test('a project file edited after enable keeps the edit; only the Context Engine blocks are removed', () => {
  const w = world();
  assert.equal(w.ce(['install', '--codex']).status, 0);
  mkdirSync(join(w.project, '.codex'));
  writeFileSync(join(w.project, '.codex', 'config.toml'), PROJECT_CODEX);
  assert.equal(w.ce(['enable']).status, 0);
  const path = join(w.project, '.codex', 'config.toml');
  writeFileSync(path, readFileSync(path, 'utf8').replace('gpt-6-luna', 'gpt-6.1-sol'));
  const dis = w.ce(['disable']);
  assert.match(dis.stdout, /config\.toml: changed by something else since install/);
  assert.equal(readFileSync(path, 'utf8'), PROJECT_CODEX.replace('gpt-6-luna', 'gpt-6.1-sol'));
});

test('an enable made before AGENTS.md was dropped (AGENTS.md section in its ledger) still reverts byte for byte', () => {
  const w = world();
  assert.equal(w.ce(['install', '--codex']).status, 0);
  writeFileSync(join(w.project, 'AGENTS.md'), AGENTS);
  const before = tree(w.project);
  assert.equal(w.ce(['enable']).status, 0);
  // What the old enable added to AGENTS.md, recorded as the ledger's "after".
  const md = join(w.project, 'AGENTS.md');
  const old = `${AGENTS}\n<!-- >>> context-engine: written by \`context-engine enable\`; \`context-engine disable\` removes it -->\n## Context Engine (Codex)\n<!-- <<< context-engine -->\n`;
  writeFileSync(md, old);
  const [ptr] = readdirSync(join(w.stateDir, 'setup', 'projects'));
  const { dir } = JSON.parse(readFileSync(join(w.stateDir, 'setup', 'projects', ptr!), 'utf8'));
  const ledger = JSON.parse(readFileSync(join(dir, 'ledger.json'), 'utf8'));
  mkdirSync(join(dir, 'before-md'),{mode:0o700});
  writeFileSync(join(dir, 'before-md', 'AGENTS.md'), AGENTS);
  mkdirSync(join(dir, 'after-md'),{mode:0o700});
  writeFileSync(join(dir, 'after-md', 'AGENTS.md'), old);
  ledger.files.push({ path: md, before: join(dir, 'before-md', 'AGENTS.md'), after: join(dir, 'after-md', 'AGENTS.md') });
  writeFileSync(join(dir, 'ledger.json'), JSON.stringify(ledger));
  assert.equal(w.ce(['disable']).status, 0);
  assert.deepEqual(tree(w.project), { ...before, '.codex/': 'dir' });
});

test('uninstall --codex also removes the project settings enable wrote', () => {
  const w = world();
  assert.equal(w.ce(['install', '--codex']).status, 0);
  const before = tree(w.project);
  assert.equal(w.ce(['enable']).status, 0);
  const un = w.ce(['uninstall', '--codex']);
  assert.equal(un.status, 0, un.stderr);
  assert.deepEqual(tree(w.project), { ...before, '.codex/': 'dir' });
});

/**
 * Every mention of full replacement says its granularity (issue #16: never unqualified): per user
 * turn, per model step, or at agent-initiated resets (the Codex plugin path).
 */
function assertQualified(text: string): void {
  for (const m of text.matchAll(/full replacement(.{0,26})/gi)) assert.match(m[1]!, /^ (per user turn|per model step|at agent-initiated resets)/, `unqualified: ${m[0]}`);
}

const trustProject = (w: ReturnType<typeof world>) =>
  writeFileSync(join(w.codexHome, 'config.toml'), `${readFileSync(join(w.codexHome, 'config.toml'), 'utf8')}\n[projects.${JSON.stringify(w.project)}]\ntrust_level = "trusted"\n`);

test('status: codex delivery modes, participation, kill switch and experiments', () => {
  const w=world();
  const status=(env: Record<string,string>={}) => {const r=w.ce(['status','--json'],{env});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);};
  const none=status();assert.equal(none.codex,null);assert.equal(none.participation.active,false);assert.equal(none.participation.state,'default');assert.equal(none.killSwitch,false);assert.deepEqual(none.experiments,[]);
  assert.equal(w.ce(['install']).status,0);assert.equal(status().codex.active,false);
  assert.equal(w.ce(['enable']).status,0);
  assert.equal(status().codex.active,false);assert.match(status().codex.problem,/does not trust/);
  trustProject(w);assert.match(status().codex.problem,/only 0\/5 plugin hooks/);trustAll(w);
  const active=status();assert.equal(active.codex.active,true);assert.equal(active.codex.mode,RESET_LABEL);assert.equal(active.codex.guidanceSeen,true);assert.equal(active.codex.hookTrustEntries,5);
  assert.equal(active.codex.tokenLimitResetMode,'Compaction-only (Codex token-limit reset; Working Context read back by the agent)');
  assert.equal(active.turnLoop.mode,'Full Replacement per user turn');
  const experiments=status({CONTEXT_ENGINE_EXPERIMENTS:'stale-refs,unknown'});assert.deepEqual(experiments.experiments,['stale-refs']);assert.equal(experiments.codex.mode,RESET_LABEL);
  const missing=status({FAKE_CODEX_TOKEN_BUDGET_GONE:'1'});assert.equal(missing.codex.active,false);assert.equal(missing.codex.mode,'inactive');assert.equal(missing.codex.guidanceSeen,false);
  const killed=status({CONTEXT_ENGINE:'off'});assert.equal(killed.killSwitch,true);assert.equal(killed.codex.active,false);assert.equal(killed.participation.active,false);
  assert.equal(w.ce(['disable']).status,0);const disabled=status();assert.equal(disabled.participation.state,'off');assert.equal(disabled.codex.mode,'inactive');
});

test('status: when Codex no longer applies the token_budget settings, Codex is reported inactive with the reason, never as the reset mode', () => {
  const w = world();
  assert.equal(w.ce(['install', '--codex']).status, 0);
  assert.equal(w.ce(['enable']).status, 0);
  trustProject(w);
  trustAll(w);
  const gone = w.ce(['status'], { env: { FAKE_CODEX_TOKEN_BUDGET_GONE: '1' } }).stdout;
  assert.match(gone, /^  Delivery Mode: inactive here \(`codex debug prompt-input` shows no Context Engine token_budget guidance/m);
  assert.doesNotMatch(gone, /Delivery Mode: Full Replacement at agent-initiated resets/);
  assert.match(gone, /Per-user-turn path: `context-engine-codex-turns`/);
  const json = JSON.parse(w.ce(['status', '--json'], { env: { FAKE_CODEX_TOKEN_BUDGET_GONE: '1' } }).stdout);
  assert.deepEqual([json.codex.mode, json.codex.active, json.codex.guidanceSeen], ['inactive', false, false]);
});

/** Stand-in request rendering exercises shipped config; it is not real host delivery evidence. */
function fakePromptInput(w: ReturnType<typeof world>, cwd: string): unknown {
  const r=spawnSync(process.execPath,[FAKE_CODEX,'debug','prompt-input','SYNTHETIC_PROMPT'],{cwd,encoding:'utf8',env:{...process.env,...w.env},timeout:5000});
  assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);
}

test('offline default-off isolation: installing codex does not activate an unselected project', () => {
  const w=world(), enabled=tempDir('enabled-project');
  writeFileSync(join(w.codexHome,'config.toml'),`# synthetic trust\n[projects.${JSON.stringify(w.project)}]\ntrust_level = "trusted"\n[projects.${JSON.stringify(enabled)}]\ntrust_level = "trusted"\n`);
  const beforePrompt=fakePromptInput(w,w.project);
  const beforeProject=tree(w.project),beforeState=tree(w.stateDir);
  const inactive=(env: Record<string,string>={}) => {
    const r=w.ce(['record','--session','OFF','--runner','codex','--hard-limit','9000','--if-enabled'],{env,input:JSON.stringify([{role:'user',text:'SHOULD_NOT_BE_RECORDED'}])});
    assert.equal(r.status,0,r.stderr);const value=JSON.parse(r.stdout);assert.equal(value.ok,true);assert.equal(value.active,false);
  };
  inactive();assert.deepEqual(tree(w.project),beforeProject);assert.deepEqual(tree(w.stateDir),beforeState);
  assert.equal(w.ce(['install']).status,0);
  assert.deepEqual(fakePromptInput(w,w.project),beforePrompt);
  const installedState=tree(w.stateDir);inactive();assert.deepEqual(tree(w.stateDir),installedState);
  assert.equal(w.ce(['enable'],{cwd:enabled}).status,0);
  assert.match(JSON.stringify(fakePromptInput(w,enabled)),/context_window_guidance/);assert.deepEqual(fakePromptInput(w,w.project),beforePrompt);
  const active=w.ce(['record','--session','ON','--runner','codex','--hard-limit','9000','--if-enabled'],{cwd:enabled,input:JSON.stringify([{role:'user',text:'ENABLED_PROJECT_TASK'}])});
  assert.equal(active.status,0,active.stdout+active.stderr);assert.ok(JSON.parse(active.stdout).revision>0);assert.match(readFileSync(join(enabled,'.context-engine','ON','context.md'),'utf8'),/ENABLED_PROJECT_TASK/);
  assert.equal(existsSync(join(enabled,'.context-engine','ON','context.md')),true);
  assert.equal(w.ce(['close','--session','ON'],{cwd:enabled}).status,0);
  const enabledState=tree(w.stateDir);inactive();assert.deepEqual(tree(w.project),beforeProject);assert.deepEqual(tree(w.stateDir),enabledState);
  assert.equal(w.ce(['disable'],{cwd:enabled}).status,0);
  assert.equal(w.ce(['uninstall']).status,0);assert.deepEqual(fakePromptInput(w,w.project),beforePrompt);inactive();assert.deepEqual(tree(w.project),beforeProject);
});

const realCodexVersion = process.env.CONTEXT_ENGINE_REAL_CODEX_TESTS === '1' ? spawnSync('codex', ['--version'], { encoding: 'utf8', timeout: 5000 }) : null;
const realCodex = realCodexVersion?.status === 0 && /\bcodex-cli 0\.160\.0\b/.test(realCodexVersion.stdout);

/** `codex debug prompt-input` in `cwd` (offline), without the per-call ids and timestamps. */
function realPromptInput(w: ReturnType<typeof world>, cwd: string): unknown {
  const r = spawnSync('codex', ['debug', 'prompt-input', 'hello'], { cwd, encoding: 'utf8', env: { ...process.env, ...w.env }, timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  const strip = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(strip) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'id' && k !== 'create_time').map(([k, x]) => [k, strip(x)])) : v;
  return strip(JSON.parse(r.stdout.slice(r.stdout.indexOf('['))));
}

nodeTest(
  'real codex (scratch CODEX_HOME): a project nobody enabled gets the same prompt input with the plugin installed as without, while another project is enabled; uninstall restores config.toml byte for byte',
  { skip: process.env.CONTEXT_ENGINE_REAL_CODEX_TESTS !== '1' ? 'Real Codex integration not requested: requires an authorized supported-host scratch trial' : realCodex ? false : 'supported codex-cli 0.160.0 is not available on PATH' },
  () => {
    const w = world();
    const enabled = tempDir('enabled-project');
    const real = { CONTEXT_ENGINE_CODEX_BIN: 'codex' };
    const config = `# scratch\n\n[projects.${JSON.stringify(w.project)}]\ntrust_level = "trusted"\n\n[projects.${JSON.stringify(enabled)}]\ntrust_level = "trusted"\n`;
    writeFileSync(join(w.codexHome, 'config.toml'), config);
    const without = realPromptInput(w, w.project);

    const inst = w.ce(['install', '--codex', '--trust-hooks'], { env: real });
    assert.equal(inst.status, 0, inst.stdout + inst.stderr);
    assert.equal(w.ce(['enable'], { cwd: enabled, env: real }).status, 0);
    // The enabled project does get the guidance, so the comparison below would see it if it leaked.
    assert.match(JSON.stringify(realPromptInput(w, enabled)), /Context Engine manages this context window/);
    assert.match(w.ce(['status'], { cwd: enabled, env: real }).stdout, /active here \(Context Engine guidance seen/);

    assert.deepEqual(realPromptInput(w, w.project), without, 'not enabled: byte-for-byte the same model-visible input');

    assert.equal(w.ce(['disable'], { cwd: enabled, env: real }).status, 0);
    assert.equal(existsSync(join(enabled, '.codex')), false);
    const un = w.ce(['uninstall', '--codex'], { env: real });
    assert.equal(un.status, 0, un.stdout + un.stderr);
    assert.equal(readFileSync(join(w.codexHome, 'config.toml'), 'utf8'), config);
    assert.equal(existsSync(join(w.codexHome, 'plugins', 'cache', 'context-engine')), false);
    assert.deepEqual(realPromptInput(w, w.project), without);
  },
);

test('round trip: codex install, enable, record, edit, sync, disable and uninstall preserve unrelated bytes', () => {
  const w=world();writeFileSync(join(w.claudeHome,'settings.json'),SETTINGS);writeFileSync(join(w.codexHome,'config.toml'),CODEX_CONFIG);writeFileSync(join(w.project,'AGENTS.md'),AGENTS);
  mkdirSync(join(w.project,'.codex'));writeFileSync(join(w.project,'.codex','config.toml'),PROJECT_CODEX);
  const beforeClaude=tree(w.claudeHome),beforeCodex=tree(w.codexHome),beforeProject=tree(w.project);
  assert.equal(w.ce(['install']).status,0);assert.equal(w.ce(['enable']).status,0);
  const record=w.ce(['record','--session','CYCLE','--runner','codex','--hard-limit','9000','--if-enabled'],{input:JSON.stringify([{role:'user',text:'ORIGINAL_CYCLE_TASK'}])});assert.equal(record.status,0,record.stdout+record.stderr);assert.equal(JSON.parse(record.stdout).ok,true);assert.ok(JSON.parse(record.stdout).revision>0);
  const file=join(w.project,'.context-engine','CYCLE','context.md');assert.match(readFileSync(file,'utf8'),/ORIGINAL_CYCLE_TASK/);writeFileSync(file,'[[CTX_TURN 1 role=user]]\nSYNTHETIC_CYCLE_EDIT\n');
  const sync=w.ce(['sync','--session','CYCLE','--if-enabled']);assert.equal(sync.status,0,sync.stderr);assert.equal(JSON.parse(sync.stdout).receipt.kind,'committed');
  const read=w.ce(['read','--session','CYCLE']);assert.equal(read.status,0,read.stderr);assert.match(read.stdout,/SYNTHETIC_CYCLE_EDIT/);
  assert.equal(w.ce(['close','--session','CYCLE']).status,0);assert.equal(w.ce(['disable']).status,0);assert.equal(w.ce(['uninstall']).status,0);
  for(const [path,bytes] of Object.entries(beforeClaude))assert.equal(tree(w.claudeHome)[path],bytes,path);
  for(const [path,bytes] of Object.entries(beforeCodex))assert.equal(tree(w.codexHome)[path],bytes,path);
  assert.deepEqual(Object.fromEntries(Object.entries(tree(w.project)).filter(([path])=>!path.startsWith('.context-engine/'))),beforeProject);
  assert.match(readFileSync(file,'utf8'),/SYNTHETIC_CYCLE_EDIT/);assert.ok(Object.keys(tree(w.stateDir)).some(path=>path.endsWith('events.jsonl')),'Event Log retained');
});

test('the runtime README states supported modes, setup proof, user control and unverified limits', () => {
  const readme=readFileSync(new URL('../README.md',import.meta.url),'utf8');assertQualified(readme);
  for(const label of ["Full Replacement at agent-initiated resets (any model step); history grows between resets", "Compaction-only (Codex token-limit reset; Working Context read back by the agent)", "Compaction-only (Codex manual compaction; Working Context read back by the agent)", "Full Replacement per user turn"])assert.ok(readme.includes(label),label);
  assert.match(readme,/Give this prompt to your agent to set it up/);assert.match(readme,/off in every project/);
  assert.match(readme,/fresh disposable test project FIRST/);assert.match(readme,/NEXT REQUEST/);assert.match(readme,/file write is not proof/);
  assert.match(readme,/exact head/);assert.match(readme,/approval/);assert.match(readme,/unverified/i);assert.match(readme,/Linux[\s\S]*Node \*\*24/);
  assert.match(readme,/CONTEXT_ENGINE=off/);assert.match(readme,/context-engine-codex disable/);assert.match(readme,/context-engine-codex uninstall/);
  assert.match(readme,/prior text remains in runner transcripts and the Event Log/);assert.match(readme,/16 MiB/);
  for(const link of ['SOURCE.json','PROVENANCE.md','GLOSSARY.md','adapters/codex/README.md'])assert.ok(existsSync(new URL('../'+link,import.meta.url)),link);
  const provenance=readFileSync(new URL('../PROVENANCE.md',import.meta.url),'utf8');assert.match(provenance,/CC BY-NC 4\.0/);assert.match(provenance,/No upstream CLM code or prompt quotations are shipped/);
});
