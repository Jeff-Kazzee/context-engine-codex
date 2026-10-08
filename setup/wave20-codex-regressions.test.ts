import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../core/testing.ts';
import { participation } from '../core/index.ts';
import { codexTrusts } from './project.ts';
import { setupContext } from './runners.ts';
import { world } from './testing/world.ts';
import { locallyEnabled } from '../adapters/codex/plugin/hooks/activation.ts';

test('wave20: semantic TOML project trust accepts literal keys, spacing, escaped paths and literal values',()=>{
 const home=tempDir('trust-spelling'),root='/tmp/project',ctx=setupContext({HOME:home,CODEX_HOME:home});
 for(const text of ["[projects.'/tmp/project']\ntrust_level = 'trusted'\n",'[ projects . "/tmp/project" ]\n"trust_level" = "trusted" # comment\n',String.raw`["proj\u0065cts"."/tmp/proj\u0065ct"]`+'\ntrust_level = "trusted"\n']){
  fs.writeFileSync(join(home,'config.toml'),text);assert.equal(codexTrusts(ctx,root),true,text);
 }
 for(const text of ['notes = """\n[projects."/tmp/project"]\ntrust_level="trusted"\n"""\n','[projects."/tmp/project-other"]\ntrust_level="trusted"\n','[projects."/tmp/project"]\ntrust_level="untrusted"\n']){fs.writeFileSync(join(home,'config.toml'),text);assert.equal(codexTrusts(ctx,root),false);}
});

test('wave20: malformed Codex retirement metadata fails closed',()=>{
 const w=world();assert.equal(w.ce(['install','--codex']).status,0);assert.equal(w.ce(['enable']).status,0);
 const pointers=join(w.stateDir,'setup','projects'),file=join(pointers,fs.readdirSync(pointers).find(name=>name.endsWith('.json'))!);
 const row=JSON.parse(fs.readFileSync(file,'utf8'));fs.writeFileSync(file,JSON.stringify({...row,retired:'false'}));
 const old={...process.env};Object.assign(process.env,w.env);
 try {assert.throws(()=>locallyEnabled(w.project),/invalid Codex retirement state/);assert.equal(participation({projectRoot:w.project,stateDir:w.stateDir,env:w.env}).active,true);}
 finally {for(const key of Object.keys(process.env))if(!(key in old))delete process.env[key];Object.assign(process.env,old);}
});
test('wave20: uninstall/reinstall stays inert until re-enabled without clearing shared participation',()=>{
 const w=world();assert.equal(w.ce(['install','--codex']).status,0);assert.equal(w.ce(['enable']).status,0);
 const old={...process.env};Object.assign(process.env,w.env);
 try {
  assert.equal(locallyEnabled(w.project),true);assert.equal(w.ce(['uninstall','--codex']).status,0);assert.equal(w.ce(['install','--codex']).status,0);
  assert.equal(participation({projectRoot:w.project,stateDir:w.stateDir,env:w.env}).active,true,'other adapter shared record retained');
  assert.equal(locallyEnabled(w.project),false);assert.equal(w.ce(['enable']).status,0);assert.equal(locallyEnabled(w.project),true);
 } finally {for(const key of Object.keys(process.env))if(!(key in old))delete process.env[key];Object.assign(process.env,old);}
});
