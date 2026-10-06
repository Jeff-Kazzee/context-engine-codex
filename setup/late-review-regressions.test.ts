import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { world } from './testing/world.ts';
import { takeSnapshot,completeLedger,rollbackSnapshot } from './ledger.ts';
import { jsonRule } from './rules.ts';
const contents=(root:string):string[]=>fs.existsSync(root)?fs.readdirSync(root,{withFileTypes:true}).flatMap(e=>e.isDirectory()?contents(join(root,e.name)):[fs.readFileSync(join(root,e.name),'utf8')]):[];
for(const [name,text] of [['settings.json',JSON.stringify({env:{ANTHROPIC_API_KEY:'SYNTHETIC_ONLY'}})],['config.toml','[model_providers.synthetic.http_headers]\nAuthorization="SYNTHETIC_ONLY"\n']] as const)test('late review: credential-bearing '+name+' refuses without payload backups',()=>{
 const w=world(),file=join(w.claudeHome,name),backupRoot=join(w.stateDir,'backups');fs.writeFileSync(file,text);
 assert.throws(()=>takeSnapshot({backupRoot,kind:'synthetic',files:[file],watch:[],namespaced:[]}),/credential-bearing|unsafe.*config/i);
 assert.equal(fs.existsSync(backupRoot),false);assert.equal(contents(backupRoot).some(x=>x.includes('SYNTHETIC_ONLY')),false);assert.equal(fs.readFileSync(file,'utf8'),text);
});
test('late review: after-copy gate refuses newly introduced nested credentials',()=>{
 const w=world(),file=join(w.claudeHome,'settings.json'),backupRoot=join(w.stateDir,'backups');fs.writeFileSync(file,'{"theme":"dark"}');const snap=takeSnapshot({backupRoot,kind:'synthetic',files:[file],watch:[],namespaced:[]});
 fs.writeFileSync(file,JSON.stringify({provider:{headers:{Authorization:'SYNTHETIC_ONLY'}}}));assert.throws(()=>completeLedger(snap),/credential-bearing|unsafe.*config/i);assert.equal(contents(backupRoot).some(x=>x.includes('SYNTHETIC_ONLY')),false);
});
test('late review: benign configuration retains byte-exact backup rollback',()=>{
 const w=world(),file=join(w.claudeHome,'settings.json'),before=' { "theme" : "dark" }\n';fs.writeFileSync(file,before);const snap=takeSnapshot({backupRoot:join(w.stateDir,'backups'),kind:'synthetic',files:[file],watch:[],namespaced:[]});fs.writeFileSync(file,'{"theme":"light"}');completeLedger(snap);rollbackSnapshot(snap,{[file]:jsonRule([['theme']])});assert.equal(fs.readFileSync(file,'utf8'),before);
});
