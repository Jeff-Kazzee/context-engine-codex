import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { world } from './testing/world.ts';
import { takeSnapshot,rollbackSnapshot } from './ledger.ts';
import { jsonRule } from './rules.ts';
import { installedLedger } from './install.ts';
import { setupContext } from './runners.ts';
test('renewed: opaque rollback distinguishes invalid UTF8 bytes',()=>{
 const w=world(),path=join(w.claudeHome,'opaque');fs.writeFileSync(path,Buffer.from([0x80]));
 const snap=takeSnapshot({backupRoot:join(w.stateDir,'backups'),kind:'synthetic',files:[path],watch:[],namespaced:[]});
 fs.writeFileSync(path,Buffer.from([0x81]));rollbackSnapshot(snap,{});
 assert.deepEqual(fs.readFileSync(path),Buffer.from([0x81]));
});
test('renewed: failed managed-only install restores absent JSON file',()=>{
 const w=world(),path=join(w.claudeHome,'new.json');
 const snap=takeSnapshot({backupRoot:join(w.stateDir,'backups'),kind:'synthetic',files:[path],watch:[],namespaced:[]});
 fs.writeFileSync(path,JSON.stringify({owned:true}));rollbackSnapshot(snap,{[path]:jsonRule([['owned']])});
 assert.equal(fs.existsSync(path),false);
});
test('renewed: external ledger pointer refuses before reading its target',()=>{
 const w=world(),ctx=setupContext(w.env),outside=join(w.home,'outside');fs.mkdirSync(outside);
 fs.mkdirSync(ctx.setupDir,{recursive:true,mode:0o700});fs.writeFileSync(join(outside,'ledger.json'),'SYNTHETIC_NOT_JSON');
 fs.writeFileSync(join(ctx.setupDir,'codex'+'.json'),JSON.stringify({dir:outside}));
 assert.throws(()=>installedLedger(ctx,'codex'),/ledger.*confine|backup.*root|outside.*backup/i);
});

test('renewed: escaped quoted table keys refuse before project activation',()=>{
 const w=world();assert.equal(w.ce(['install']).status,0);fs.mkdirSync(join(w.project,'.codex'));
 const path=join(w.project,'.codex/config.toml'),text='["fea\\u0074ures".token_budget]\nenabled = false\n';fs.writeFileSync(path,text);
 const result=w.ce(['enable']);assert.equal(result.status,1);assert.match(result.stderr,/escaped|unsupported|token_budget/);assert.equal(fs.readFileSync(path,'utf8'),text);
});
test('renewed: complete markers with empty bodies do not bypass owned settings repair',()=>{
 const w=world();assert.equal(w.ce(['install']).status,0);assert.equal(w.ce(['enable']).status,0);
 const path=join(w.project,'.codex/config.toml');const text=fs.readFileSync(path,'utf8');
 fs.writeFileSync(path,text.split('\n').filter(line=>line.startsWith('# >>>')||line.startsWith('# <<<')).join('\n')+'\n');
 assert.equal(w.ce(['enable']).status,0);const repaired=fs.readFileSync(path,'utf8');assert.match(repaired,/developer_instructions\s*=/);assert.match(repaired,/\[features.token_budget\]/);
});

import { completeLedger,readLedger } from './ledger.ts';
for(const changed of ['backup','tracked','namespace']) test('renewed: forged ledger '+changed+' paths refuse under caller policy',()=>{
 const w=world(),file=join(w.claudeHome,'synthetic.conf'),owned=join(w.claudeHome,'owned');fs.writeFileSync(file,'{}');
 const backupRoot=join(w.stateDir,'backups'),snapshot=takeSnapshot({backupRoot,kind:'synthetic',files:[file],watch:[],namespaced:[owned]});
 const ledger=completeLedger(snapshot),outside=join(w.home,'outside');fs.writeFileSync(outside,'SYNTHETIC_UNRELATED');
 if(changed==='backup')ledger.files[0]!.before=outside;
 if(changed==='tracked')ledger.files[0]!.path=outside;
 if(changed==='namespace')ledger.namespaced[0]!.path=w.home;
 fs.writeFileSync(join(ledger.dir,'ledger.json'),JSON.stringify(ledger));
 assert.throws(()=>readLedger(ledger.dir,{backupRoot,files:[file],namespaced:[owned]}),/confinement/);
 assert.equal(fs.readFileSync(outside,'utf8'),'SYNTHETIC_UNRELATED');assert.equal(fs.readFileSync(file,'utf8'),'{}');
});

test('renewed: concurrent empty JSON without owned entries stays present',()=>{
 const w=world(),path=join(w.claudeHome,'concurrent-empty.json');
 const snap=takeSnapshot({backupRoot:join(w.stateDir,'backups'),kind:'synthetic',files:[path],watch:[],namespaced:[]});
 fs.writeFileSync(path,'{}\n');rollbackSnapshot(snap,{[path]:jsonRule([['owned']])});
 assert.equal(fs.readFileSync(path,'utf8'),'{}\n');
});

test('renewed: escaped dotted assignment keys refuse without overwriting existing settings',()=>{
 const w=world();assert.equal(w.ce(['install']).status,0);fs.mkdirSync(join(w.project,'.codex'));
 const path=join(w.project,'.codex/config.toml'),text='features."token\\u005fbudget".enabled = false\n';fs.writeFileSync(path,text);
 const r=w.ce(['enable']);assert.equal(r.status,1);assert.match(r.stderr,/escaped.*keys.*unsupported|unsafe configuration cannot be backed up/);assert.equal(fs.readFileSync(path,'utf8'),text);
});
test('renewed: escaped string values and comments remain unmanaged data',()=>{
 const w=world();assert.equal(w.ce(['install']).status,0);fs.mkdirSync(join(w.project,'.codex'));
 const path=join(w.project,'.codex/config.toml'),text='note = "literal\\u005fvalue"\n[features] # "comment\\u005fonly"\n';fs.writeFileSync(path,text);
 const r=w.ce(['enable']);assert.equal(r.status,0,r.stderr);assert.ok(fs.readFileSync(path,'utf8').includes(text));assert.equal(w.ce(['disable']).status,0);assert.equal(fs.readFileSync(path,'utf8'),text);
});

import { syncBuiltinESMExports } from 'node:module';
test('renewed6: linked backup root refuses before creating external artifacts',()=>{
 const w=world(),root=join(w.stateDir,'backups'),outside=join(w.home,'outside-backups');fs.mkdirSync(w.stateDir,{mode:0o700});fs.mkdirSync(outside,{mode:0o700});fs.symlinkSync(outside,root);
 assert.throws(()=>takeSnapshot({backupRoot:root,kind:'synthetic',files:[],watch:[],namespaced:[]}),/linked|verified|ELOOP/);assert.deepEqual(fs.readdirSync(outside),[]);
});
test('renewed6: planted backup copy cannot truncate unrelated target',()=>{
 const w=world(),file=join(w.claudeHome,'synthetic.conf'),target=join(w.home,'unrelated');fs.writeFileSync(file,'SOURCE');fs.writeFileSync(target,'KEEP');const native=fs.mkdirSync;let planted=false;
 fs.mkdirSync=((path:any,opts:any)=>{const r=native(path,opts);if(!planted&&String(path).endsWith('/before')){planted=true;fs.symlinkSync(target,join(String(path),'0-synthetic.conf'));}return r;}) as typeof fs.mkdirSync;syncBuiltinESMExports();
 try{assert.throws(()=>takeSnapshot({backupRoot:join(w.stateDir,'backups'),kind:'synthetic',files:[file],watch:[],namespaced:[]}));}finally{fs.mkdirSync=native;syncBuiltinESMExports();}
 assert.equal(planted,true);assert.equal(fs.readFileSync(target,'utf8'),'KEEP');
});
