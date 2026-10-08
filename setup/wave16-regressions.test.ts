import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tempDir } from '../core/testing.ts';
import { takeSnapshot, completeLedger, assess, revert } from './ledger.ts';
import { jsonRule } from './rules.ts';
import { safeRead } from './files.ts';
import { setupContext, type RunnerSpec } from './runners.ts';
import { installLocked } from './install.ts';

for (const existed of [false, true]) test('wave16: rollback preserves edits after assessment, original '+existed, () => {
  const root=tempDir('rollback-late'),file=join(root,'settings.json'),rules={[file]:jsonRule([['owned']])};
  if(existed)fs.writeFileSync(file,'{"theme":"old"}');
  const snap=takeSnapshot({backupRoot:join(root,'backups'),kind:'test',files:[file],watch:[],namespaced:[]});
  fs.writeFileSync(file,JSON.stringify({...existed?{theme:'old'}:{},owned:true}));const ledger=completeLedger(snap),unchanged=assess(ledger,rules);
  assert.equal(unchanged[file],true);fs.writeFileSync(file,'{"theme":"new","owned":true}');
  revert(ledger,rules,unchanged);assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')),{theme:'new'});
});

test('wave16: rollback deletion stays on verified parent after a replacement link',()=>{
  const root=tempDir('rollback-link'),parent=join(root,'runner'),moved=join(root,'original'),outside=join(root,'outside');fs.mkdirSync(parent);fs.mkdirSync(outside);
  const file=join(parent,'settings.json'),foreign=join(outside,'settings.json');fs.writeFileSync(foreign,'EXTERNAL_FIXTURE');
  const snap=takeSnapshot({backupRoot:join(root,'backups'),kind:'test',files:[file],watch:[],namespaced:[]});fs.writeFileSync(file,'{"owned":true}');const ledger=completeLedger(snap),rules={[file]:jsonRule([['owned']])},unchanged=assess(ledger,rules);
  const native=fs.unlinkSync,nativeRename=fs.renameSync;let swapped=false;
  const swap=(path:any)=>{if(!swapped&&String(path).endsWith('/settings.json')){swapped=true;nativeRename(parent,moved);fs.symlinkSync(outside,parent);}};
  fs.unlinkSync=((path:any)=>{swap(path);native(path);}) as typeof fs.unlinkSync;
  fs.renameSync=((from:any,to:any)=>{swap(from);nativeRename(from,to);}) as typeof fs.renameSync;syncBuiltinESMExports();
  try {revert(ledger,rules,unchanged);} finally {fs.unlinkSync=native;fs.renameSync=nativeRename;syncBuiltinESMExports();}
  assert.equal(swapped,true);assert.equal(fs.readFileSync(foreign,'utf8'),'EXTERNAL_FIXTURE');assert.equal(fs.existsSync(join(moved,'settings.json')),false);
});

test('wave16: rollback refuses a changed leaf at the deletion boundary',()=>{
  const root=tempDir('rollback-leaf'),file=join(root,'settings.json');
  const snap=takeSnapshot({backupRoot:join(root,'backups'),kind:'test',files:[file],watch:[],namespaced:[]});fs.writeFileSync(file,'{"owned":true}');const ledger=completeLedger(snap),rules={[file]:jsonRule([['owned']])},unchanged=assess(ledger,rules);
  const native=fs.renameSync;let changed=false;
  fs.renameSync=((from:any,to:any)=>{if(!changed&&String(from).endsWith('/settings.json')){changed=true;fs.writeFileSync(file,'{"theme":"late"}');}native(from,to);}) as typeof fs.renameSync;syncBuiltinESMExports();
  try {assert.throws(()=>revert(ledger,rules,unchanged),/changed|retained/);assert.equal(changed,true);assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')),{theme:'late'});}
  finally {fs.renameSync=native;syncBuiltinESMExports();}
});

for(const target of ['home','watch','config'])test('wave16: foreign '+target+' ownership refuses before config payload or runner preparation',()=>{
  const root=tempDir('owner'),file=join(root,'settings.json'),watch=join(root,'plugins');fs.mkdirSync(watch);fs.writeFileSync(file,'{"theme":"fixture"}');
  const ctx=setupContext({HOME:root,CONTEXT_ENGINE_STATE_DIR:join(root,'state')}),native=fs.fstatSync,nativeRead=fs.readSync;let payload=0,prepared=false;
  fs.fstatSync=((fd:number,...args:any[])=>{const st=(native as any)(fd,...args),p=fs.realpathSync(`/proc/self/fd/${fd}`);return p===(target==='home'?root:target==='watch'?watch:file)?Object.assign(Object.create(Object.getPrototypeOf(st)),st,{uid:(process.getuid?.()??0)+1}):st;}) as typeof fs.fstatSync;
  fs.readSync=((fd:number,...args:any[])=>{if(fs.realpathSync(`/proc/self/fd/${fd}`)===file)payload++;return (nativeRead as any)(fd,...args);}) as typeof fs.readSync;syncBuiltinESMExports();
  const spec:RunnerSpec={id:'codex',title:'Synthetic',home:root,bin:'unused',files:[file],watch:[watch],namespaced:[],rules:{},install:[],uninstall:[],prepare:()=>{prepared=true;}};
  try {assert.throws(()=>installLocked(ctx,spec),/owner/);assert.equal(payload,0);assert.equal(prepared,false);assert.equal(fs.existsSync(join(ctx.setupDir,'backups')),false);assert.throws(()=>target==='config'?safeRead(file):installLocked(ctx,spec),/owner/);}
  finally {fs.fstatSync=native;fs.readSync=nativeRead;syncBuiltinESMExports();}
});
