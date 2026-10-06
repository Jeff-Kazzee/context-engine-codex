import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { fixture, tempDir } from './testing.ts';
import { cite, openSession, participation, setParticipation } from './index.ts';
import { appendLog, truncateTornTail, projectKey, layout, ensureDirs, readConfined } from './store.ts';

test('renewed: corrupt nearest opt-out never inherits enabled ancestor', () => {
 const f=fixture(),child=join(f.projectRoot,'child');fs.mkdirSync(child);
 setParticipation({...f,state:'on'});setParticipation({...f,projectRoot:child,state:'off'});
 fs.writeFileSync(join(f.stateDir,'participation',projectKey(child)+'.json'),'{broken');
 assert.equal(participation({...f,projectRoot:child,env:{}}).active,false);
});
for(const type of ['symbolic','hard']) test('renewed: linked EventLog refuses append and truncation '+type,()=>{
 const root=tempDir('loglink'),outside=join(root,'outside'),log=join(root,'events.jsonl');
 fs.writeFileSync(outside,'UNRELATED_PARTIAL');
 if(type==='symbolic')fs.symlinkSync(outside,log);else fs.linkSync(outside,log);
 assert.throws(()=>truncateTornTail(log),/linked|verified|ELOOP/);
 assert.throws(()=>appendLog(log,{type:'synthetic'}),/linked|verified|ELOOP/);
 assert.equal(fs.readFileSync(outside,'utf8'),'UNRELATED_PARTIAL');
});
test('renewed: WC mkdir swap cannot create a session outside project',()=>{
 const f=fixture(),wcRoot=join(f.projectRoot,'.context-engine'),outside=tempDir('mkdir-outside');
 fs.mkdirSync(wcRoot,{mode:0o700});const native=fs.mkdirSync;let swapped=false;
 fs.mkdirSync=((path:any,options:any)=>{if(!swapped&&String(path).endsWith('/S1')&&(String(path).startsWith(wcRoot)||String(path).startsWith('/proc/self/fd/')&&fs.realpathSync(dirname(String(path)))===wcRoot)){swapped=true;fs.renameSync(wcRoot,wcRoot+'.old');fs.symlinkSync(outside,wcRoot);}return native(path,options);}) as typeof fs.mkdirSync;
 syncBuiltinESMExports();try{assert.throws(()=>ensureDirs(layout(f.projectRoot,'S1',f.stateDir),f.stateDir));}
 finally{fs.mkdirSync=native;syncBuiltinESMExports();}
 assert.equal(swapped,true);assert.deepEqual(fs.readdirSync(outside),[]);
});
test('renewed: oversized sparse cited source refuses before payload read',()=>{
 const f=fixture(),path=join(f.projectRoot,'huge.txt');fs.writeFileSync(path,'');fs.truncateSync(path,32*1024*1024);
 const native=fs.readFileSync;let payloadRead=false;
 fs.readFileSync=((fd:any,...args:any[])=>{if(typeof fd==='number'&&fs.realpathSync('/proc/self/fd/'+fd)===path){payloadRead=true;throw new Error('test prevented oversized allocation');}return (native as any)(fd,...args);}) as typeof fs.readFileSync;
 syncBuiltinESMExports();try{assert.throws(()=>cite(f.projectRoot,'huge.txt'),/too.large|size.limit|oversized/i);assert.equal(payloadRead,false);}
 finally{fs.readFileSync=native;syncBuiltinESMExports();}
});

test('renewed: revision directory is synced before HEAD publication',()=>{
 const f=fixture(),opened=openSession({...f,sessionId:'S1',runner:'test',hardLimit:10000});assert.equal(opened.status,'open');
 const calls:string[]=[],nativeSync=fs.fsyncSync,nativeRename=fs.renameSync;
 fs.fsyncSync=((fd:number)=>{calls.push('sync:'+fs.realpathSync('/proc/self/fd/'+fd));nativeSync(fd);}) as typeof fs.fsyncSync;
 fs.renameSync=((from:any,to:any)=>{calls.push('rename:'+String(to));return nativeRename(from,to);}) as typeof fs.renameSync;syncBuiltinESMExports();
 try{opened.session.record([{role:'user',text:'DURABILITY_ORDER'}]);}
 finally{fs.fsyncSync=nativeSync;fs.renameSync=nativeRename;syncBuiltinESMExports();opened.session.close();}
 const revision=calls.findIndex(s=>s==='sync:'+join(opened.session.stateDir,'revisions'));
 const head=calls.findIndex(s=>s.startsWith('rename:')&&s.endsWith('/HEAD'));
 assert.ok(revision>=0&&head>revision,JSON.stringify(calls));
 assert.ok(calls.slice(head+1).includes('sync:'+opened.session.stateDir));
});
