import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fixture,tempDir} from './testing.ts';
import {openSession} from './index.ts';
import {acquireLock,holderFor,releaseLock} from './lock.ts';
import {appendLog,readLockPublicationCandidate} from './store.ts';

test('wave29: durable but failed receipt acknowledgement survives reopen',()=>{
 const f=fixture(),r=openSession({...f,sessionId:'S1',runner:'test',hardLimit:10000});assert.equal(r.status,'open');
 r.session.record([{role:'user',text:'ORIGINAL'}]);const log=join(r.session.stateDir,'events.jsonl'),write=fs.writeSync;
 fs.writeSync=((fd:number,data:any,...args:any[])=>{if(fs.readlinkSync(`/proc/self/fd/${fd}`)===log&&String(data).includes('"type":"revision"'))throw new Error('synthetic accounting failure');return (write as any)(fd,data,...args);}) as typeof fs.writeSync;syncBuiltinESMExports();
 try{assert.throws(()=>r.session.record([{role:'assistant',text:'SECOND'}]),/accounting failure/);r.session.close();}finally{fs.writeSync=write;syncBuiltinESMExports();}
 const reopened=openSession({...f,sessionId:'S1',runner:'test',hardLimit:10000});assert.equal(reopened.status,'open');const flush=fs.fsyncSync;let failed=false;
 fs.fsyncSync=((fd:number)=>{flush(fd);if(!failed&&fs.readlinkSync(`/proc/self/fd/${fd}`)===log&&fs.readFileSync(log,'utf8').trimEnd().split('\n').at(-1)!.includes('"type":"revision-receipt-delivered"')){failed=true;throw new Error('synthetic post-write receipt flush failure');}}) as typeof fs.fsyncSync;syncBuiltinESMExports();
 try{assert.throws(()=>reopened.session.sync(),/post-write receipt flush failure/);}finally{fs.fsyncSync=flush;syncBuiltinESMExports();}reopened.session.close();assert.equal(failed,true);
 const retry=openSession({...f,sessionId:'S1',runner:'test',hardLimit:10000});assert.equal(retry.status,'open');assert.match(retry.session.sync().receipt?.text??'',/recovered.*revision 2/);assert.equal(retry.session.sync().receipt,undefined);retry.session.close();
});

test('wave29: publisher exit after hard-link publication permits dead-holder recovery',()=>{
 const root=tempDir('lock-publisher'),path=join(root,'session.lock');
 const child=spawnSync(process.execPath,['--input-type=module','-e',`import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';import {acquireLock,holderFor} from ${JSON.stringify(new URL('./lock.ts',import.meta.url).href)};const native=fs.linkSync;fs.linkSync=(a,b)=>{native(a,b);process.exit(0);};syncBuiltinESMExports();acquireLock(${JSON.stringify(path)},holderFor(99999999,'test',1000));`],{encoding:'utf8',timeout:5000});assert.equal(child.status,0,child.stderr);assert.equal(fs.lstatSync(path).nlink,2);
 const me=holderFor(process.pid,'test',1000);assert.equal(acquireLock(path,me).status,'acquired');assert.equal(fs.lstatSync(path).nlink,1);releaseLock(path,me);
});

test('wave29: dead publisher cleanup preserves a distinct live session owner',()=>{
 const root=tempDir('live-owner'),path=join(root,'session.lock');
 const child=spawnSync(process.execPath,['--input-type=module','-e',`import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';import {acquireLock,holderFor} from ${JSON.stringify(new URL('./lock.ts',import.meta.url).href)};const native=fs.linkSync;fs.linkSync=(a,b)=>{native(a,b);process.exit(0);};syncBuiltinESMExports();acquireLock(${JSON.stringify(path)},holderFor(process.ppid,'test',1000));`],{encoding:'utf8',timeout:5000});assert.equal(child.status,0,child.stderr);
 const result=acquireLock(path,holderFor(99999998,'test',1000));assert.equal(result.status,'refused');assert.equal(result.holder.pid,process.pid);assert.equal(fs.lstatSync(path).nlink,1);
 // Release with the holder that the live owner published, so the lock really ends.
 releaseLock(path,result.holder);assert.equal(fs.existsSync(path),false);
});

test('wave29: arbitrary hard-linked lock remains refused and untouched',()=>{
 const root=tempDir('foreign-lock'),path=join(root,'session.lock'),foreign=join(root,'foreign');fs.writeFileSync(foreign,JSON.stringify(holderFor(99999999,'test',1000)));fs.linkSync(foreign,path);
 assert.throws(()=>acquireLock(path,holderFor(process.pid,'test',1000)),/link/i);assert.equal(fs.lstatSync(foreign).nlink,2);
});

test('wave29: candidate descriptor identity is verified before any payload read',()=>{
 const root=tempDir('candidate-swap'),target=join(root,'session.lock'),candidate=target+'.99999999.12345678.new',foreign=join(root,'foreign');
 fs.writeFileSync(target,'ORIGINAL');fs.linkSync(target,candidate);fs.writeFileSync(foreign,'SYNTHETIC_FOREIGN');
 const open=fs.openSync,read=fs.readSync;let swapped=false,reads=0;
 fs.openSync=((path:any,...args:any[])=>{if(String(path)===candidate&&!swapped){swapped=true;fs.unlinkSync(candidate);fs.linkSync(foreign,candidate);}return (open as any)(path,...args);}) as typeof fs.openSync;
 fs.readSync=((...args:any[])=>{reads++;return (read as any)(...args);}) as typeof fs.readSync;syncBuiltinESMExports();
 try{assert.throws(()=>readLockPublicationCandidate(candidate,target,candidate),/identity changed/);}finally{fs.openSync=open;fs.readSync=read;syncBuiltinESMExports();}
 assert.equal(swapped,true);assert.equal(reads,0);assert.equal(fs.readFileSync(target,'utf8'),'ORIGINAL');assert.equal(fs.readFileSync(foreign,'utf8'),'SYNTHETIC_FOREIGN');
});

function pendingReceipts(count:number){
 const f=fixture(),r=openSession({...f,sessionId:'S1',runner:'test',hardLimit:10000});assert.equal(r.status,'open');r.session.record([{role:'user',text:'FIRST'}]);
 if(count===2)r.session.record([{role:'assistant',text:'SECOND'}]);const state=r.session.stateDir,log=join(state,'events.jsonl');r.session.close();
 const entries=fs.readFileSync(log,'utf8').trim().split('\n').map(line=>JSON.parse(line));
 for(const row of entries.filter(row=>row.type==='revision'))appendLog(log,{type:'revision',rev:row.rev,sha:row.sha,kind:row.kind,chars:row.chars,recovered:true});
 return {f,log};
}

test('wave29: failed second acknowledgement cannot confirm an unreturned first notice',()=>{
 const {f,log}=pendingReceipts(2),r=openSession({...f,sessionId:'S1',runner:'test',hardLimit:10000});assert.equal(r.status,'open');const write=fs.writeSync;let failed=false;
 fs.writeSync=((fd:number,data:any,...args:any[])=>{if(fs.readlinkSync(`/proc/self/fd/${fd}`)===log&&String(data).includes('"type":"revision-receipt-delivered"')&&String(data).includes('"rev":2')){failed=true;throw new Error('synthetic second acknowledgement failure');}return (write as any)(fd,data,...args);}) as typeof fs.writeSync;syncBuiltinESMExports();
 try{assert.throws(()=>r.session.sync(),/second acknowledgement/);}finally{fs.writeSync=write;syncBuiltinESMExports();}r.session.close();assert.equal(failed,true);
 const retry=openSession({...f,sessionId:'S1',runner:'test',hardLimit:10000});assert.equal(retry.status,'open');const text=retry.session.sync().receipt?.text??'';assert.match(text,/revision 1/);assert.match(text,/revision 2/);retry.session.close();
});

test('wave29: ordinary successive CLI processes retire a positively written recovery notice',()=>{
 const {f}=pendingReceipts(1),cli=new URL('./cli.ts',import.meta.url);const call=()=>spawnSync(process.execPath,[cli.pathname,'sync','--session','S1','--project',f.projectRoot,'--runner','test','--hard-limit','10000'],{cwd:f.projectRoot,encoding:'utf8',env:{...process.env,CONTEXT_ENGINE_STATE_DIR:f.stateDir}});
 const first=call();assert.equal(first.status,0,first.stderr);assert.match(JSON.parse(first.stdout).receipt.text,/recovered.*revision 1/);
 const second=call();assert.equal(second.status,0,second.stderr);assert.equal(JSON.parse(second.stdout).receipt,undefined);
});

test('wave29: confirmation refuses a closed session without another log write',()=>{
 const f=fixture(),r=openSession({...f,sessionId:'S1',runner:'test',hardLimit:10000});assert.equal(r.status,'open');r.session.close();const log=join(r.session.stateDir,'events.jsonl'),before=fs.readFileSync(log);
 assert.throws(()=>r.session.confirmReceiptReturn(),/closed/);assert.deepEqual(fs.readFileSync(log),before);
});

for(const fault of ['short-eagain','outer-release'])test('wave29: CLI output remains one complete result under '+fault,()=>{
 const {f}=pendingReceipts(1),preload=join(f.projectRoot,'output-fault.mjs'),cli=new URL('./cli.ts',import.meta.url);
 fs.writeFileSync(preload,`import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const write=fs.writeSync,unlink=fs.unlinkSync;let writes=0;fs.writeSync=function(fd,data,offset,length,...args){if(fd===1&&${JSON.stringify(fault)}==='short-eagain'){writes++;if(writes===1)return write(fd,data,offset,Math.min(length,7),...args);if(writes===2)throw Object.assign(new Error('synthetic backpressure'),{code:'EAGAIN'});}return write(fd,data,offset,length,...args);};fs.unlinkSync=function(path){if(${JSON.stringify(fault)}==='outer-release'&&String(path).endsWith('/lock.op'))throw new Error('synthetic outer release failure');return unlink(path);};syncBuiltinESMExports();`);
 const args=[cli.pathname,'sync','--session','S1','--project',f.projectRoot,'--runner','test','--hard-limit','10000'];
 const env={...process.env,CONTEXT_ENGINE_STATE_DIR:f.stateDir};const result=spawnSync(process.execPath,args,{cwd:f.projectRoot,encoding:'utf8',env:{...env,NODE_OPTIONS:'--import='+preload}});assert.equal(result.status,0,result.stderr);assert.match(JSON.parse(result.stdout).receipt.text,/recovered.*revision 1/);
 const next=spawnSync(process.execPath,args,{cwd:f.projectRoot,encoding:'utf8',env});assert.equal(next.status,0,next.stderr);assert.equal(JSON.parse(next.stdout).receipt,undefined);
});

test('wave29: large actual CLI pipe output completes and retires its receipt',()=>{
 const f=fixture(),r=openSession({...f,sessionId:'S1',runner:'test',hardLimit:1000000});assert.equal(r.status,'open');r.session.record([{role:'user',text:'LARGE_OUTPUT '.repeat(20000)}]);const log=join(r.session.stateDir,'events.jsonl');r.session.close();const revision=fs.readFileSync(log,'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line)).find(row=>row.type==='revision');appendLog(log,{type:'revision',rev:revision.rev,sha:revision.sha,kind:revision.kind,chars:revision.chars,recovered:true});
 const args=[new URL('./cli.ts',import.meta.url).pathname,'sync','--session','S1','--project',f.projectRoot,'--runner','test','--hard-limit','1000000'],opts={cwd:f.projectRoot,encoding:'utf8' as const,maxBuffer:4000000,env:{...process.env,CONTEXT_ENGINE_STATE_DIR:f.stateDir}};
 const first=spawnSync(process.execPath,args,opts);assert.equal(first.status,0,first.stderr);assert.ok(first.stdout.length>200000);assert.match(JSON.parse(first.stdout).receipt.text,/recovered/);
 const second=spawnSync(process.execPath,args,opts);assert.equal(second.status,0,second.stderr);assert.equal(JSON.parse(second.stdout).receipt,undefined);
});
