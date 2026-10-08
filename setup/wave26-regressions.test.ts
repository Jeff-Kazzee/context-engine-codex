import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {join} from 'node:path';
import {tempDir} from '../core/testing.ts';
import {takeSnapshot,completeLedger,discardSnapshot,assess,revert} from './ledger.ts';
import {jsonRule} from './rules.ts';
import {setupContext,type RunnerSpec} from './runners.ts';
import {installLocked,uninstallLocked} from './install.ts';

for(const key of ['Cookie','Set-Cookie'])test('wave26: recognized '+key+' refuses both backup phases',()=>{
 const root=tempDir('cookie-backup'),file=join(root,'settings.json'),backupRoot=join(root,'backups');
 const synthetic=JSON.stringify({headers:{[key]:'SYNTHETIC_COOKIE'}});fs.writeFileSync(file,synthetic);
 assert.throws(()=>takeSnapshot({backupRoot,kind:'cookie',files:[file],watch:[],namespaced:[]}),/credential|unsafe/);assert.equal(fs.existsSync(backupRoot),false);
 fs.writeFileSync(file,'{"theme":"safe"}');const snap=takeSnapshot({backupRoot,kind:'cookie',files:[file],watch:[],namespaced:[]});fs.writeFileSync(file,synthetic);
 assert.throws(()=>completeLedger(snap),/credential|unsafe/);assert.deepEqual(fs.readdirSync(join(snap.dir,'after')),[]);
});

test('wave26: created file in a preexisting namespace cannot delete through a redirected parent',()=>{
 const root=tempDir('created-cleanup'),parent=join(root,'plugins'),namespace=join(parent,'context-engine'),moved=join(root,'moved'),outside=join(root,'outside');fs.mkdirSync(namespace,{recursive:true});fs.mkdirSync(join(outside,'context-engine'),{recursive:true});
 const file=join(namespace,'created.txt'),foreign=join(outside,'context-engine','created.txt');fs.writeFileSync(foreign,'EXTERNAL');
 const snap=takeSnapshot({backupRoot:join(root,'backups'),kind:'created',files:[],watch:[parent],namespaced:[namespace]});fs.writeFileSync(file,'OWNED');const ledger=completeLedger(snap);
 const native=fs.readSync;let swapped=false;
 fs.readSync=((fd:number,...args:any[])=>{const result=(native as any)(fd,...args);if(!swapped&&result>0&&fs.realpathSync(`/proc/self/fd/${fd}`)===file){swapped=true;fs.renameSync(parent,moved);fs.symlinkSync(outside,parent);}return result;}) as typeof fs.readSync;syncBuiltinESMExports();
 try {try{revert(ledger,{},{});}catch(error){assert.match(String(error),/linked|changed|verify/);}}finally{fs.readSync=native;syncBuiltinESMExports();}
 assert.equal(swapped,true);assert.equal(fs.readFileSync(foreign,'utf8'),'EXTERNAL');
});

for(const target of ['home','watch','config'])test('wave26: uninstall checks '+target+' ownership before any runner command',()=>{
 const root=tempDir('uninstall-owner'),home=join(root,'runner'),watch=join(home,'plugins'),file=join(home,'settings.json'),witness=join(root,'command-ran'),bin=join(root,'fake-runner.ts');fs.mkdirSync(watch,{recursive:true});fs.writeFileSync(file,'{"theme":"safe"}');fs.writeFileSync(bin,`import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(witness)},'ran');`);
 const ctx=setupContext({HOME:root,CONTEXT_ENGINE_STATE_DIR:join(root,'state')}),spec:RunnerSpec={id:'codex',title:'Synthetic',home,bin,files:[file],watch:[watch],namespaced:[],rules:{},install:[],uninstall:[['remove']]};installLocked(ctx,spec);
 const native=fs.fstatSync;fs.fstatSync=((fd:number,...args:any[])=>{const st=(native as any)(fd,...args),path=fs.realpathSync(`/proc/self/fd/${fd}`);return path===(target==='home'?home:target==='watch'?watch:file)?Object.assign(Object.create(Object.getPrototypeOf(st)),st,{uid:(process.getuid?.()??0)+1}):st;}) as typeof fs.fstatSync;syncBuiltinESMExports();
 try{assert.throws(()=>uninstallLocked(ctx,spec),/owner/);assert.equal(fs.existsSync(witness),false);}finally{fs.fstatSync=native;syncBuiltinESMExports();}
});

test('wave26: restore refuses a late ancestor swap without creating external suffix directories',()=>{
 const root=tempDir('restore-mkdir'),parent=join(root,'runner'),moved=join(root,'moved'),outside=join(root,'outside'),file=join(parent,'nested','settings.json');fs.mkdirSync(join(parent,'nested'),{recursive:true});fs.mkdirSync(outside);fs.writeFileSync(file,'{"theme":"safe"}');
 const rules={[file]:jsonRule([['owned']])},snap=takeSnapshot({backupRoot:join(root,'backups'),kind:'restore',files:[file],watch:[],namespaced:[]});fs.writeFileSync(file,'{"theme":"safe","owned":true}');const ledger=completeLedger(snap),unchanged=assess(ledger,rules),backup=ledger.files[0]!.before!;
 const native=fs.readSync;let swapped=false;
 fs.readSync=((fd:number,...args:any[])=>{const result=(native as any)(fd,...args);if(!swapped&&result>0&&fs.realpathSync(`/proc/self/fd/${fd}`)===backup){swapped=true;fs.renameSync(parent,moved);fs.symlinkSync(outside,parent);}return result;}) as typeof fs.readSync;syncBuiltinESMExports();
 try{assert.throws(()=>revert(ledger,rules,unchanged),/linked|changed|verify/);}finally{fs.readSync=native;syncBuiltinESMExports();}
 assert.equal(swapped,true);assert.equal(fs.existsSync(join(outside,'nested')),false);
});

test('wave26: an already missing tracked file remains missing and does not enter restore mkdir',()=>{
 const root=tempDir('missing-restore'),file=join(root,'settings.json');fs.writeFileSync(file,'{"theme":"safe"}');const rules={[file]:jsonRule([['owned']])},snap=takeSnapshot({backupRoot:join(root,'backups'),kind:'restore',files:[file],watch:[],namespaced:[]});fs.writeFileSync(file,'{"theme":"safe","owned":true}');const ledger=completeLedger(snap);fs.unlinkSync(file);
 assert.equal(revert(ledger,rules,assess(ledger,rules))[0]!.outcome,'missing');assert.equal(fs.existsSync(file),false);
});

test('wave26: discarded publication snapshot preserves unexpected entries',()=>{
 const root=tempDir('discard-retention'),file=join(root,'config');fs.writeFileSync(file,'ORIGINAL');
 const snap=takeSnapshot({backupRoot:join(root,'backups'),kind:'publication',files:[file],watch:[],namespaced:[]});
 const unexpected=join(snap.dir,'before','unexpected.txt');fs.writeFileSync(unexpected,'CONCURRENT');
 assert.throws(()=>discardSnapshot(snap),/not empty|ENOTEMPTY/);assert.equal(fs.readFileSync(unexpected,'utf8'),'CONCURRENT');assert.equal(fs.readFileSync(file,'utf8'),'ORIGINAL');
});
