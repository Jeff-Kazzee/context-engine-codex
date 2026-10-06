
// New hosted-review regressions use scratch homes and synthetic config only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { world, tree } from './testing/world.ts';
import { takeSnapshot, rollbackSnapshot, completeLedger } from './ledger.ts';
const runtime: string = 'codex';
test('linked install pointer refuses before runner commands or target creation', () => {
  const w = world(); mkdirSync(join(w.stateDir, 'setup'), { recursive: true });
  const target = join(runtime === 'claude' ? w.codexHome : w.claudeHome, 'unowned-config.json');
  const pointer = join(w.stateDir, 'setup', `${runtime}.json`);
  symlinkSync(target, pointer);
  const beforeClaude = tree(w.claudeHome), beforeCodex = tree(w.codexHome);
  const r = w.ce(['install']); assert.equal(r.status, 1); assert.match(r.stderr, /linked/);
  assert.equal(existsSync(target), false);
  assert.deepEqual(tree(w.claudeHome), beforeClaude); assert.deepEqual(tree(w.codexHome), beforeCodex);
});
for (const action of ['rollback', 'complete']) test(`${action} retains unowned empty directories`, () => {
  const w = world(), owned = join(w.stateDir, 'watched', 'owned'), unowned = join(w.stateDir, 'watched', 'another-plugin');
  mkdirSync(join(w.stateDir, 'watched'), { recursive: true });
  const snapshot = takeSnapshot({ backupRoot: join(w.stateDir, 'backups'), kind: 'test', files: [], watch: [join(w.stateDir, 'watched')], namespaced: [owned] });
  mkdirSync(owned); mkdirSync(unowned);
  if (action === 'rollback') { rollbackSnapshot(snapshot, {}); assert.equal(existsSync(owned), false); }
  else assert.deepEqual(completeLedger(snapshot).createdDirs, [owned]);
  assert.equal(existsSync(unowned), true);
});

import { readFileSync, writeFileSync } from 'node:fs';
import { install, uninstall } from './install.ts';
import { setupContext } from './runners.ts';
import { jsonRule } from './rules.ts';
test('already-installed recovery names this runtime CLI', () => {
  const w = world(); assert.equal(w.ce(['install']).status, 0);
  const again = w.ce(['install']); assert.equal(again.status, 1);
  assert.ok(again.stderr.includes('context-engine-' + runtime + ' uninstall'));
});
test('reverse JSON edit restores a preexisting managed leaf alongside new user settings', () => {
  const rule = jsonRule([['enabledPlugins','ce@ce']]);
  const before = JSON.stringify({enabledPlugins:{'ce@ce': false}, theme:'dark'});
  const now = JSON.stringify({enabledPlugins:{'ce@ce':true}, theme:'light'});
  assert.deepEqual(JSON.parse(rule.strip(now,before)), {enabledPlugins:{'ce@ce':false},theme:'light'});
});
test('uninstall preserves unrelated configuration changed during runner removal', () => {
  const w=world(), config=join(w.claudeHome,'synthetic.json');
  writeFileSync(config, JSON.stringify({theme:'before', owned:false}));
  const ctx={...setupContext(w.env),setupDir:join(w.stateDir,'setup')};
  const rule=jsonRule([['owned']]);
  const script="const fs=require('node:fs'); const p=process.argv[1]; const x=JSON.parse(fs.readFileSync(p,'utf8')); x.theme='concurrent'; delete x.owned; fs.writeFileSync(p,JSON.stringify(x));";
  const spec:any={id:runtime,title:'Synthetic',bin:process.execPath,files:[config],watch:[],namespaced:[],rules:{[config]:rule},install:[],uninstall:[['-e',script,config]],prepare(){writeFileSync(config,JSON.stringify({theme:'before',owned:true}));}};
  install(ctx,spec); uninstall(ctx,spec);
  assert.deepEqual(JSON.parse(readFileSync(config,'utf8')), {theme:'concurrent',owned:false});
});

test('post-install activation guidance names the Codex CLI', () => {
  const w=world(), r=w.ce(['install']); assert.equal(r.status,0,r.stderr);
  assert.match(r.stdout,/Inert until `context-engine-codex enable`/);
});
for (const prefix of ['matrix = [\n  [1, 2],\n  [3, 4],\n]\n', 'note = """\n[looks.like.table]\n"""\n']) test('top-level conflict after complex TOML value is refused: '+prefix.split('=')[0], () => {
  const w=world(); assert.equal(w.ce(['install']).status,0);
  mkdirSync(join(w.project,'.codex')); const file=join(w.project,'.codex/config.toml');
  const original=prefix+'developer_instructions = "USER_SETTING"\n'; writeFileSync(file,original);
  const r=w.ce(['enable']); assert.equal(r.status,1); assert.match(r.stderr,/already sets developer_instructions/);
  assert.equal(readFileSync(file,'utf8'),original);
});
test('inherited activation probes the actual descendant cwd and respects descendant guidance override', () => {
  const w=world(); assert.equal(w.ce(['install','--trust-hooks']).status,0);
  writeFileSync(join(w.codexHome,'config.toml'),readFileSync(join(w.codexHome,'config.toml'),'utf8')+'\n[projects.'+JSON.stringify(w.project)+']\ntrust_level = "trusted"\n');
  assert.equal(w.ce(['enable']).status,0);
  const child=join(w.project,'child'); mkdirSync(join(child,'.codex'),{recursive:true});
  writeFileSync(join(child,'.codex/config.toml'),'developer_instructions = "CHILD_OVERRIDE"\n');
  const r=w.ce(['status','--json'],{cwd:child}); assert.equal(r.status,0,r.stderr);
  const status=JSON.parse(r.stdout); assert.equal(status.participation.active,true);
  assert.equal(status.codex.active,false); assert.equal(status.codex.guidanceSeen,false);
});

for (const quote of ['"', "'"]) for (const count of [4,5]) test(`TOML multiline ${quote} ending with ${count} quotes retains conflict detection`, () => {
  const w=world(); assert.equal(w.ce(['install']).status,0);
  mkdirSync(join(w.project,'.codex')); const file=join(w.project,'.codex/config.toml');
  const original='note = '+quote.repeat(3)+'\nvalue'+quote.repeat(count)+'\ndeveloper_instructions = "USER_SETTING"\n';
  writeFileSync(file,original); const r=w.ce(['enable']);
  assert.equal(r.status,1); assert.match(r.stderr,/already sets developer_instructions/);
  assert.equal(readFileSync(file,'utf8'),original);
});
test('escaped quoted TOML keys refuse before inserting conflicting guidance', () => {
  const w=world(); assert.equal(w.ce(['install']).status,0);
  mkdirSync(join(w.project,'.codex')); const file=join(w.project,'.codex/config.toml');
  const original='"\\u0064eveloper_instructions" = "USER_SETTING"\n';
  writeFileSync(file,original); const r=w.ce(['enable']);
  assert.equal(r.status,1); assert.match(r.stderr,/escaped quoted.*unsupported/);
  assert.equal(readFileSync(file,'utf8'),original);
});
