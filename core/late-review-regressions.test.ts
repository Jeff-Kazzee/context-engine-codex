import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { fixture, tempDir } from './testing.ts';
import { readLock, holderFor, acquireLock } from './lock.ts';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { atomicWrite, sessionFrameKey, readLog, layout } from './store.ts';
import { openSession, inspectSession, recall, show } from './index.ts';

for (const kind of ['symbolic','hard']) test(`late review: ${kind} linked lock refuses without payload reads`,()=>{
 const root=tempDir('linked-lock'), target=join(root,'synthetic-target'), lock=join(root,'lock');
 fs.writeFileSync(target,JSON.stringify({...holderFor(process.pid,'synthetic',100),extra:'SYNTHETIC_ONLY'}),{mode:0o600});
 if(kind==='symbolic')fs.symlinkSync(target,lock);else fs.linkSync(target,lock);
 const native=fs.readFileSync;let payload=false;
 fs.readFileSync=((p:any,...args:any[])=>{if(p===lock || typeof p==='number'&&fs.readlinkSync('/proc/self/fd/'+p)===target)payload=true;return (native as any)(p,...args);}) as typeof fs.readFileSync;syncBuiltinESMExports();
 try{assert.throws(()=>readLock(lock));assert.equal(payload,false);}finally{fs.readFileSync=native;syncBuiltinESMExports();}
});
test('late review: lock holder projects declared fields only',()=>{
 const root=tempDir('holder'),lock=join(root,'lock'),holder=holderFor(process.pid,'synthetic',100);
 fs.writeFileSync(lock,JSON.stringify({...holder,unexpected:'SYNTHETIC_ONLY'}),{mode:0o600});
 assert.deepEqual(readLock(lock),holder);
});
test('late review: transient two-name lock publication preserves the live holder',async()=>{
 const root=tempDir('transient-lock'),lock=join(root,'lock'),ready=join(root,'ready');
 const child=spawn(process.execPath,['--input-type=module','-e',`import fs from 'node:fs';import os from 'node:os';const lock=${JSON.stringify(lock)},candidate=lock+'.new';fs.writeFileSync(candidate,JSON.stringify({pid:process.pid,hostname:os.hostname(),startMarker:null,runner:'synthetic',hardLimit:100,acquiredAt:new Date().toISOString()}),{mode:0o600});fs.linkSync(candidate,lock);fs.writeFileSync(${JSON.stringify(ready)},'ready');setTimeout(()=>fs.unlinkSync(candidate),30);setInterval(()=>{},1000);`],{stdio:'ignore'});
 const exited=once(child,'exit');try{
  const deadline=Date.now()+5000;while(!fs.existsSync(ready)){if(Date.now()>deadline)throw new Error('synthetic publication did not start');await new Promise(r=>setTimeout(r,2));}
  const got=acquireLock(lock,holderFor(process.pid,'synthetic',100));assert.equal(got.status,'refused');const current=readLock(lock);assert.ok(current && current!=='unreadable');assert.equal(current.pid,child.pid);assert.equal(fs.existsSync(lock),true);
 }finally{child.kill();await exited;}
});
test('late review: oversized frame key is repaired before payload allocation',()=>{
 const root=tempDir('frame'),key=join(root,'frame-key');fs.writeFileSync(key,'x',{mode:0o600});fs.truncateSync(key,2*1024*1024);
 const native=fs.readFileSync;let oversized=false;
 fs.readFileSync=((p:any,...args:any[])=>{if(typeof p==='number'&&fs.readlinkSync('/proc/self/fd/'+p)===key&&fs.fstatSync(p).size>33){oversized=true;throw new Error('unbounded frame allocation');}return (native as any)(p,...args);}) as typeof fs.readFileSync;syncBuiltinESMExports();
 try{const value=sessionFrameKey(root);assert.match(value,/^[a-f0-9]{32}$/);assert.equal(sessionFrameKey(root),value);assert.equal(oversized,false);}finally{fs.readFileSync=native;syncBuiltinESMExports();}
});
test('late review: private state publication remains anchored after parent verification',()=>{
 const base=tempDir('private-race'),parent=join(base,'state'),moved=parent+'.moved',outside=join(base,'outside');fs.mkdirSync(parent,{mode:0o700});fs.mkdirSync(outside,{mode:0o700});fs.writeFileSync(join(outside,'HEAD'),'SYNTHETIC_UNCHANGED');
 const native=fs.readlinkSync;let swapped=false;
 fs.readlinkSync=((p:any,...args:any[])=>{const real=(native as any)(p,...args);if(!swapped&&real===parent){swapped=true;fs.renameSync(parent,moved);fs.symlinkSync(outside,parent);}return real;}) as typeof fs.readlinkSync;syncBuiltinESMExports();
 try{atomicWrite(join(parent,'HEAD'),'SYNTHETIC_NEW','head-tmp');assert.equal(swapped,true);assert.equal(fs.readFileSync(join(outside,'HEAD'),'utf8'),'SYNTHETIC_UNCHANGED');assert.equal(fs.readFileSync(join(moved,'HEAD'),'utf8'),'SYNTHETIC_NEW');assert.deepEqual(fs.readdirSync(outside),['HEAD']);}finally{fs.readlinkSync=native;syncBuiltinESMExports();}
});
test('late review: malformed complete event batches refuse without discarding later evidence',()=>{
 const f=fixture(),opts={...f,sessionId:'S1',runner:'synthetic',hardLimit:100000};let r=openSession(opts);assert.equal(r.status,'open');r.session.record([{role:'user',text:'SYNTHETIC_FIRST'}]);r.session.close();
 const l=layout(f.projectRoot,'S1',f.stateDir);fs.rmSync(join(l.stateDir,'recovery.json'),{force:true});
 const prior=fs.readFileSync(l.events,'utf8'),context=fs.readFileSync(l.workingContext);
 const bad=[{type:'runner-events',events:null},{type:'runner-events',events:[{seq:2,event:null}]},{type:'runner-events',events:[{seq:2,event:{role:'user',text:7}}]}];
 const valid={type:'runner-events',events:[{seq:2,event:{role:'user',text:'SYNTHETIC_LATER'}}]};fs.appendFileSync(l.events,[...bad,valid].map(x=>JSON.stringify(x)+'\n').join(''));
 const damaged=fs.readFileSync(l.events);
 assert.throws(()=>[...readLog(l.events)],/invalid complete record/);
 assert.throws(()=>openSession(opts),/invalid complete record/);
 assert.deepEqual(fs.readFileSync(l.events),damaged);assert.deepEqual(fs.readFileSync(l.workingContext),context);
 // Restore this synthetic fixture's known-good source explicitly, then recover the retained valid event.
 fs.writeFileSync(l.events,prior+JSON.stringify(valid)+'\n');
 r=openSession(opts);assert.equal(r.status,'open');try{assert.match(r.session.sync().workingContextText,/SYNTHETIC_LATER/);assert.equal(recall({...f,sessionId:'S1',query:'SYNTHETIC_LATER'}).total,1);assert.match(show({...f,sessionId:'S1',id:'e2'}).text,/SYNTHETIC_LATER/);}finally{r.session.close();}
});

test('late review: nonboolean materialization refuses before stale context can commit',()=>{
 const f=fixture(),opts={...f,sessionId:'S1',runner:'synthetic',hardLimit:100000},r=openSession(opts);assert.equal(r.status,'open');r.session.record([{role:'user',text:'SYNTHETIC_COMMITTED'}]);r.session.close();
 const l=layout(f.projectRoot,'S1',f.stateDir),head=JSON.parse(fs.readFileSync(l.head,'utf8'));head.materialized='false';fs.writeFileSync(l.head,JSON.stringify(head));const before=fs.readFileSync(l.workingContext);
 assert.throws(()=>openSession(opts),/HEAD/);assert.deepEqual(fs.readFileSync(l.workingContext),before);assert.throws(()=>inspectSession({...f,sessionId:'S1'}),/HEAD/);
});
