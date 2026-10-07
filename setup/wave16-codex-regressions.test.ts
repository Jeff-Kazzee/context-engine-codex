import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../core/testing.ts';
import { codexPluginEnabled } from './status.ts';
import { trustCodexHooks } from './codex-trust.ts';
import { setupContext, codexSpec } from './runners.ts';

test('wave16: equivalent TOML plugin table keys report the same enabled state',()=>{
  const home=tempDir('toml-status'),ctx=setupContext({HOME:home,CODEX_HOME:home});
  for(const table of ['[plugins."context-engine@context-engine"]',"[ plugins . 'context-engine@context-engine' ]",'[ "plugins" . "context-engine@context-engine" ] # comment',String.raw`["\U00000070lugins"."context-engine@context-engine"]`,String.raw`["other\U00000078"]`+'\nvalue = false\n'+String.raw`["plug\u0069ns"."context-engine@context-engine"]`]){
    writeFileSync(join(home,'config.toml'),table+'\nenabled = true # comment\n[unrelated]\nenabled = false\n');assert.equal(codexPluginEnabled(ctx),true,table);
  }
  for(const text of ['[plugins."context-engine@context-engine"]\nenabled = false\n','notes = """\n[plugins."context-engine@context-engine"]\nenabled = true\n"""\n',"[plugins.'other']\nenabled = true\n"]){
    writeFileSync(join(home,'config.toml'),text);assert.equal(codexPluginEnabled(ctx),false);
  }
});

for(const scenario of ['missing','duplicate','empty-hash','unverified','changed-hash','valid'])test('wave16: explicit hook trust '+scenario,async()=>{
  const home=tempDir('trust-fake'),marker=join(home,'wrote'),bin=join(home,'runner.mjs'),ctx=setupContext({HOME:home,CODEX_HOME:home,CONTEXT_ENGINE_CODEX_BIN:bin});
  writeFileSync(bin,`import readline from 'node:readline';import{writeFileSync}from'node:fs';let wrote=false;const scenario=${JSON.stringify(scenario)};const hooks=()=>Array.from({length:scenario==='missing'?4:5},(_,i)=>({key:scenario==='duplicate'?'duplicate':'hook-'+i,pluginId:'context-engine@context-engine',currentHash:scenario==='empty-hash'?'':scenario==='changed-hash'&&wrote?'new-'+i:'hash-'+i,trustStatus:wrote&&scenario!=='unverified'?'trusted':'untrusted'}));for await(const line of readline.createInterface({input:process.stdin})){const r=JSON.parse(line);if(r.id===undefined)continue;let result={};if(r.method==='hooks/list')result={data:[{hooks:hooks()}]};if(r.method==='config/batchWrite'){wrote=true;writeFileSync(${JSON.stringify(marker)},'fixture');}process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n');}`);
  if(scenario==='valid'){assert.match((await trustCodexHooks(ctx,codexSpec(ctx))).join('\n'),/5\/5 trusted/);assert.equal(existsSync(marker),true);}
  else {await assert.rejects(()=>trustCodexHooks(ctx,codexSpec(ctx)),/hooks|trust|hash/i);assert.equal(existsSync(marker),['unverified','changed-hash'].includes(scenario));}
});
