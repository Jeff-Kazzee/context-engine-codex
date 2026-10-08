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

import { recall,show,inspectSession } from './index.ts';
for(const kind of ['symbolic','hard','modified']) test('renewed6: revision snapshots reject '+kind+' substitution',()=>{
 const f=fixture(),opened=openSession({...f,sessionId:'S1',runner:'test',hardLimit:10000});assert.equal(opened.status,'open');
 const s=opened.session,result=s.record([{role:'user',text:'GOOD_REVISION'}]),path=join(s.stateDir,'revisions',result.revision+'.md'),target=join(tempDir('unrelated'),'data');fs.writeFileSync(target,'SYNTHETIC_UNRELATED_BYTES');
 fs.unlinkSync(path);if(kind==='symbolic')fs.symlinkSync(target,path);else if(kind==='hard')fs.linkSync(target,path);else fs.writeFileSync(path,'SYNTHETIC_WRONG_REVISION');
 assert.throws(()=>s.sync(),/linked|verified|checksum|ELOOP/);assert.throws(()=>inspectSession({...f,sessionId:'S1'}),/linked|verified|checksum|ELOOP/);
 assert.equal(fs.readFileSync(target,'utf8'),'SYNTHETIC_UNRELATED_BYTES');s.close();
});
test('renewed6: recovery recall and show scan log without whole-file allocation',()=>{
 const f=fixture(),opened=openSession({...f,sessionId:'S1',runner:'test',hardLimit:10000});assert.equal(opened.status,'open');const s=opened.session;
 s.record([{role:'user',text:'STREAM_EVIDENCE'}]);const log=join(s.stateDir,'events.jsonl');s.close();
 const row=JSON.stringify({type:'diagnostic',text:'x'.repeat(4096)})+'\n';for(let i=0;i<1024;i++)fs.appendFileSync(log,row);
 const native=fs.readFileSync;fs.readFileSync=((path:any,...args:any[])=>{if(path===log||typeof path==='number'&&fs.realpathSync('/proc/self/fd/'+path)===log)throw new Error('whole-log allocation refused by test');return (native as any)(path,...args);}) as typeof fs.readFileSync;syncBuiltinESMExports();
 try{assert.equal(recall({...f,sessionId:'S1',query:'STREAM_EVIDENCE'}).total,1);assert.match(show({...f,sessionId:'S1',id:'e1'}).text,/STREAM_EVIDENCE/);const reopened=openSession({...f,sessionId:'S1',runner:'test',hardLimit:10000});assert.equal(reopened.status,'open');assert.match(reopened.session.sync().workingContextText,/STREAM_EVIDENCE/);reopened.session.close();}
 finally{fs.readFileSync=native;syncBuiltinESMExports();}
});

import { readLog } from './store.ts';
test('renewed6: streaming log keeps UTF8 across chunks, ignores torn tails and refuses corrupt complete records',()=>{
 const path=join(tempDir('stream'),'events.jsonl'),text='漢'.repeat(30000);
 const valid=JSON.stringify({type:'synthetic',text})+'\n'+JSON.stringify({type:'next',text:'OK'})+'\n';
 fs.writeFileSync(path,valid+JSON.stringify({type:'torn'}));
 assert.deepEqual([...readLog(path)],[{type:'synthetic',text},{type:'next',text:'OK'}]);
 const damaged=valid+'NOT_JSON\n';fs.writeFileSync(path,damaged);
 assert.throws(()=>[...readLog(path)],/malformed JSON/);assert.equal(fs.readFileSync(path,'utf8'),damaged);
});
