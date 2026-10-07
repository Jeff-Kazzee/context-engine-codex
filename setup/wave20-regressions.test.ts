import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tempDir } from '../core/testing.ts';
import { takeSnapshot,completeLedger,assess,revert } from './ledger.ts';
import { jsonRule } from './rules.ts';

for(const changed of [false,true]) test('wave20: rollback replacement preserves a write after captured current bytes, reverse edit '+changed,()=>{
 const root=tempDir('replacement'),file=join(root,'settings.json'),rules={[file]:jsonRule([['owned']])};fs.writeFileSync(file,'{"theme":"before"}');
 const snap=takeSnapshot({backupRoot:join(root,'backups'),kind:'test',files:[file],watch:[],namespaced:[]});fs.writeFileSync(file,'{"theme":"before","owned":true}');
 const ledger=completeLedger(snap),unchanged=assess(ledger,rules);if(changed)fs.writeFileSync(file,'{"theme":"first-unmanaged","owned":true}');
 const native=fs.renameSync;let swapped=false;
 fs.renameSync=((from:any,to:any)=>{if(!swapped&&(String(from).includes('.context-engine-setup-')||String(to).includes('.context-engine-replace-'))){swapped=true;fs.writeFileSync(file,'{"theme":"latest-unmanaged","owned":true}');}return native(from,to);}) as typeof fs.renameSync;syncBuiltinESMExports();
 try {assert.throws(()=>revert(ledger,rules,unchanged),/changed|retained|exist/);}finally {fs.renameSync=native;syncBuiltinESMExports();}
 assert.equal(swapped,true);assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')),{theme:'latest-unmanaged',owned:true});
});
test('wave20: namespace rollback refuses an ancestor redirected since ledger verification',()=>{
 const root=tempDir('namespace'),parent=join(root,'plugins'),namespace=join(parent,'context-engine'),outside=join(root,'outside'),moved=join(root,'original');fs.mkdirSync(parent);fs.mkdirSync(outside);
 const snap=takeSnapshot({backupRoot:join(root,'backups'),kind:'test',files:[],watch:[parent],namespaced:[namespace]});fs.mkdirSync(namespace);fs.writeFileSync(join(namespace,'owned'),'OWNED');
 fs.mkdirSync(join(outside,'context-engine'));fs.writeFileSync(join(outside,'context-engine','foreign'),'PRESERVE');const ledger=completeLedger(snap);
 fs.renameSync(parent,moved);fs.symlinkSync(outside,parent);
 assert.throws(()=>revert(ledger,{},{}),/linked|changed|verify/);assert.equal(fs.readFileSync(join(outside,'context-engine','foreign'),'utf8'),'PRESERVE');
});
