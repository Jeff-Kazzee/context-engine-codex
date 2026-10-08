import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tempDir } from '../core/testing.ts';
import { setupContext, type RunnerSpec } from './runners.ts';
import { installLocked, uninstallLocked } from './install.ts';
import { takeSnapshot, completeLedger, assess, revert } from './ledger.ts';
import { blockRule, jsonRule } from './rules.ts';

test('wave13: credential-bearing current configuration is refused before any reverse-edit copy',()=>{
  const root=tempDir('reverse-secret'),file=join(root,'config.toml'),markers={begin:'# OWNED BEGIN',end:'# OWNED END'},rule=blockRule(markers);
  fs.writeFileSync(file,'theme = "original"\n');const s=takeSnapshot({backupRoot:join(root,'backups'),kind:'synthetic',files:[file],watch:[],namespaced:[]});fs.writeFileSync(file,'theme = "original"\n# OWNED BEGIN\nmanaged = true\n# OWNED END\n');const l=completeLedger(s);
  fs.appendFileSync(file,'\n[unrelated]\napi_key = "SYNTHETIC_FIXTURE_ONLY"\n');const before=fs.readFileSync(file);let copied=false;const native=fs.writeFileSync;
  fs.writeFileSync=((path:any,data:any,...args:any[])=>{if(String(data).includes('SYNTHETIC_FIXTURE_ONLY'))copied=true;return (native as any)(path,data,...args);}) as typeof fs.writeFileSync;syncBuiltinESMExports();
  try {assert.throws(()=>revert(l,{[file]:rule},assess(l,{[file]:rule})),/credential-bearing|unsafe configuration/);assert.equal(copied,false);assert.deepEqual(fs.readFileSync(file),before);}
  finally {fs.writeFileSync=native;syncBuiltinESMExports();}
});

for(const fail of [false,true])test('wave13: uninstall flushes verified pointer parent '+(fail?'failure':'success'),()=>{
  const root=tempDir('uninstall-flush'),ctx=setupContext({HOME:root,CONTEXT_ENGINE_STATE_DIR:join(root,'state')}),config=join(root,'settings.json');fs.writeFileSync(config,'{"theme":"original"}');
  const spec:RunnerSpec={id:'claude',title:'Synthetic',home:root,bin:'unused',files:[config],watch:[],namespaced:[],rules:{[config]:jsonRule([['owned']])},install:[],uninstall:[],prepare:()=>fs.writeFileSync(config,'{"theme":"original","owned":true}')};installLocked(ctx,spec);
  const pointer=join(ctx.setupDir,'claude.json'),native=fs.fsyncSync;let flushed=false;
  fs.fsyncSync=((fd:number)=>{if(fs.fstatSync(fd).isDirectory()&&fs.realpathSync(`/proc/self/fd/${fd}`)===ctx.setupDir&&!fs.existsSync(pointer)){flushed=true;if(fail)throw new Error('synthetic delete flush failure');}native(fd);}) as typeof fs.fsyncSync;syncBuiltinESMExports();
  try {if(fail)assert.throws(()=>uninstallLocked(ctx,spec),/synthetic delete flush failure/);else uninstallLocked(ctx,spec);assert.equal(flushed,true);assert.equal(fs.existsSync(pointer),false);}
  finally {fs.fsyncSync=native;syncBuiltinESMExports();}
});

test('wave13: runner inventory refuses excess entries without accepting partial ownership',()=>{
  const root=tempDir('inventory-bound'),watch=join(root,'plugins'),seed=join(root,'seed');fs.mkdirSync(watch);fs.writeFileSync(seed,'safe');const fileStat=fs.lstatSync(seed);
  const nativeRead=fs.readdirSync,nativeOpen=fs.opendirSync,nativeStat=fs.lstatSync;let visited=0;
  fs.readdirSync=((path:any,...args:any[])=>String(path)===watch?Array.from({length:5000},(_,i)=>'entry-'+i):(nativeRead as any)(path,...args)) as typeof fs.readdirSync;
  fs.opendirSync=((path:any,...args:any[])=>{if(String(path)!==watch)return (nativeOpen as any)(path,...args);let i=0;return {readSync:()=>i<5000?{name:'entry-'+i++}:null,closeSync:()=>{}};}) as typeof fs.opendirSync;
  (fs as any).lstatSync=((path:any,...args:any[])=>{if(String(path).startsWith(watch+'/entry-')){visited++;return fileStat;}return (nativeStat as any)(path,...args);});syncBuiltinESMExports();
  try {assert.throws(()=>takeSnapshot({backupRoot:join(root,'backups'),kind:'synthetic',files:[],watch:[watch],namespaced:[]}),/inventory.*limit|inventory.*bound/);assert.ok(visited<=4096);}
  finally {fs.readdirSync=nativeRead;fs.opendirSync=nativeOpen;(fs as any).lstatSync=nativeStat;syncBuiltinESMExports();}
});

test('wave13: post-command inventory exhaustion preserves backups and restores tracked bytes',()=>{
  const root=tempDir('inventory-rollback'),watch=join(root,'plugins'),config=join(root,'settings.json');fs.mkdirSync(watch);fs.writeFileSync(config,'{"theme":"original"}');const fileStat=fs.lstatSync(config),ctx=setupContext({HOME:root,CONTEXT_ENGINE_STATE_DIR:join(root,'state')});let expanded=false;
  const nativeRead=fs.readdirSync,nativeOpen=fs.opendirSync,nativeStat=fs.lstatSync;
  fs.readdirSync=((path:any,...args:any[])=>expanded&&String(path)===watch?Array.from({length:5000},(_,i)=>'entry-'+i):(nativeRead as any)(path,...args)) as typeof fs.readdirSync;
  fs.opendirSync=((path:any,...args:any[])=>{if(!expanded||String(path)!==watch)return (nativeOpen as any)(path,...args);let i=0;return {readSync:()=>i<5000?{name:'entry-'+i++}:null,closeSync:()=>{}};}) as typeof fs.opendirSync;
  (fs as any).lstatSync=((path:any,...args:any[])=>expanded&&String(path).startsWith(watch+'/entry-')?fileStat:(nativeStat as any)(path,...args));syncBuiltinESMExports();
  const spec:RunnerSpec={id:'claude',title:'Synthetic',home:root,bin:'unused',files:[config],watch:[watch],namespaced:[],rules:{[config]:jsonRule([['owned']])},install:[],uninstall:[],prepare:()=>{fs.writeFileSync(config,'{"theme":"original","owned":true}');expanded=true;}};
  try {assert.throws(()=>installLocked(ctx,spec),/rollback.*incomplete|inventory/);assert.equal(fs.readFileSync(config,'utf8'),'{"theme":"original"}');assert.equal(fs.existsSync(join(ctx.setupDir,'claude.json')),false);const snapshots=fs.readdirSync(join(ctx.setupDir,'backups'));assert.equal(snapshots.length,1);assert.equal(fs.readFileSync(join(ctx.setupDir,'backups',snapshots[0]!,'before','0-settings.json'),'utf8'),'{"theme":"original"}');}
  finally {fs.readdirSync=nativeRead;fs.opendirSync=nativeOpen;(fs as any).lstatSync=nativeStat;syncBuiltinESMExports();}
});
