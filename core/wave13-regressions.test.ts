import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join, dirname } from 'node:path';
import { fixture } from './testing.ts';
import { inspectSession, openSession } from './index.ts';
import { appendLog, readLog, resolveStateRoot } from './store.ts';
import { budgetMemory } from './budget.ts';
import { armCrash } from './faults.ts';

test('wave13: oversized snapshot refuses before payload read in status and recovery',()=>{
  const f=fixture(),r=openSession({...f,sessionId:'S1',runner:'test',hardLimit:10000});assert.equal(r.status,'open');
  r.session.record([{role:'user',text:'SAFE'}]);const snapshot=join(r.session.stateDir,'revisions','1.md');r.session.close();fs.truncateSync(snapshot,65*1024*1024);
  const native=fs.readFileSync;let reads=0;
  fs.readFileSync=((path:any,...args:any[])=>{const p=typeof path==='number'?fs.readlinkSync(`/proc/self/fd/${path}`):String(path);if(p===snapshot){reads++;throw new Error('synthetic payload allocation prevented');}return (native as any)(path,...args);}) as typeof fs.readFileSync;syncBuiltinESMExports();
  try {assert.throws(()=>inspectSession({...f,sessionId:'S1'}),/size limit|read limit/);assert.throws(()=>openSession({...f,sessionId:'S1',runner:'test',hardLimit:10000}),/size limit|read limit/);assert.equal(reads,0);}
  finally {fs.readFileSync=native;syncBuiltinESMExports();}
});

for(const next of [1,2])test('wave13: sequence regression/duplicate across log batches refuses '+next,()=>{
  const f=fixture(),r=openSession({...f,sessionId:'S1',runner:'test',hardLimit:10000});assert.equal(r.status,'open');const log=join(r.session.stateDir,'events.jsonl'),wc=r.session.workingContextPath;r.session.close();
  appendLog(log,{type:'runner-events',events:[{seq:2,event:{role:'user',text:'STALE'}}]});appendLog(log,{type:'runner-events',events:[{seq:next,event:{role:'user',text:'REGRESSED'}}]});
  assert.throws(()=>openSession({...f,sessionId:'S1',runner:'test',hardLimit:10000}),/sequence.*regress|non-monotonic/);assert.equal(fs.existsSync(wc),false);
});

test('wave13: HEAD commit with failed revision append recovers accounting and receipt once',()=>{
  const f=fixture(),r=openSession({...f,sessionId:'S1',runner:'test',hardLimit:10000,budgetTokens:1000});assert.equal(r.status,'open');r.session.record([{role:'user',text:'ORIGINAL'}]);
  const log=join(r.session.stateDir,'events.jsonl'),wc=r.session.workingContextPath;fs.writeFileSync(wc,'EDITED '.repeat(50));
  const native=fs.writeSync;let failed=false;
  fs.writeSync=((fd:number,data:any,...args:any[])=>{if(!failed&&fs.readlinkSync(`/proc/self/fd/${fd}`)===log&&String(data).includes('"type":"revision"')){failed=true;throw new Error('synthetic revision log full');}return (native as any)(fd,data,...args);}) as typeof fs.writeSync;syncBuiltinESMExports();
  try {assert.throws(()=>r.session.sync(),/synthetic revision log full/);}finally {fs.writeSync=native;syncBuiltinESMExports();}
  assert.equal(failed,true);assert.equal([...readLog(log)].filter(e=>e.type==='revision'&&e.rev===2).length,0);r.session.close();
  const reopened=openSession({...f,sessionId:'S1',runner:'test',hardLimit:10000,budgetTokens:1000});assert.equal(reopened.status,'open');const result=reopened.session.sync();assert.equal(result.revision,2);assert.match(result.receipt?.text??'',/recover|committed/);assert.equal([...readLog(log)].filter(e=>e.type==='revision'&&e.rev===2).length,1);assert.equal(budgetMemory(readLog(log),1000).lastTokens,Math.ceil(result.chars/4));reopened.session.close();
  const again=openSession({...f,sessionId:'S1',runner:'test',hardLimit:10000,budgetTokens:1000});assert.equal(again.status,'open');again.session.sync();again.session.close();assert.equal([...readLog(log)].filter(e=>e.type==='revision'&&e.rev===2).length,1);
});

test('wave13: new ignore file and its parent flush before session readiness',()=>{
  const f=fixture(),native=fs.fsyncSync,flushed:string[]=[];
  fs.fsyncSync=((fd:number)=>{flushed.push(fs.realpathSync(`/proc/self/fd/${fd}`));native(fd);}) as typeof fs.fsyncSync;syncBuiltinESMExports();
  try {const r=openSession({...f,sessionId:'S1',runner:'test',hardLimit:10000});assert.equal(r.status,'open');r.session.close();}
  finally {fs.fsyncSync=native;syncBuiltinESMExports();}
  const ignore=join(f.projectRoot,'.context-engine','.gitignore');assert.ok(flushed.includes(ignore));assert.ok(flushed.indexOf(ignore)<flushed.lastIndexOf(dirname(ignore)));
});

test('wave13: ignore flush failure prevents opening a session',()=>{
  const f=fixture(),native=fs.fsyncSync;let failed=false;
  fs.fsyncSync=((fd:number)=>{if(fs.realpathSync(`/proc/self/fd/${fd}`).endsWith('/.context-engine/.gitignore')){failed=true;throw new Error('synthetic ignore flush failure');}native(fd);}) as typeof fs.fsyncSync;syncBuiltinESMExports();
  try {assert.throws(()=>openSession({...f,sessionId:'S1',runner:'test',hardLimit:10000}),/synthetic ignore flush failure/);}
  finally {fs.fsyncSync=native;syncBuiltinESMExports();}assert.equal(failed,true);
  const retry=openSession({...f,sessionId:'S1',runner:'test',hardLimit:10000});assert.equal(retry.status,'open');retry.session.close();
});

test('wave13: failed accounting repair remains retryable and preserves runner growth',()=>{
  const f=fixture(),r=openSession({...f,sessionId:'S1',runner:'test',hardLimit:10000,budgetTokens:1000});assert.equal(r.status,'open');r.session.record([{role:'user',text:'ORIGINAL'}]);const log=join(r.session.stateDir,'events.jsonl');
  const native=fs.writeSync;let failures=0;
  fs.writeSync=((fd:number,data:any,...args:any[])=>{if(fs.readlinkSync(`/proc/self/fd/${fd}`)===log&&String(data).includes('"type":"revision"')){failures++;throw new Error('synthetic revision accounting unavailable');}return (native as any)(fd,data,...args);}) as typeof fs.writeSync;syncBuiltinESMExports();
  try {assert.throws(()=>r.session.record([{role:'assistant',text:'GROWTH '.repeat(100)}]),/synthetic revision accounting unavailable/);r.session.close();assert.throws(()=>openSession({...f,sessionId:'S1',runner:'test',hardLimit:10000,budgetTokens:1000}),/synthetic revision accounting unavailable/);}
  finally {fs.writeSync=native;syncBuiltinESMExports();}
  assert.equal(failures,2);const retry=openSession({...f,sessionId:'S1',runner:'test',hardLimit:10000,budgetTokens:1000});assert.equal(retry.status,'open');const result=retry.session.sync();assert.match(result.receipt?.text??'',/recover/);assert.match(result.workingContextText,/GROWTH/);const memory=budgetMemory(readLog(log),1000);assert.equal(memory.lastTokens,Math.ceil(result.chars/4));assert.ok(memory.growth.at(-1)!>100);assert.equal([...readLog(log)].filter(e=>e.type==='revision'&&e.rev===2).length,1);retry.session.close();
});

test('wave13: repaired accounting notice survives failed cold materialization',()=>{
  const f=fixture(),r=openSession({...f,sessionId:'S1',runner:'test',hardLimit:10000});assert.equal(r.status,'open');r.session.record([{role:'user',text:'ORIGINAL'}]);const log=join(r.session.stateDir,'events.jsonl'),native=fs.writeSync;
  fs.writeSync=((fd:number,data:any,...args:any[])=>{if(fs.readlinkSync(`/proc/self/fd/${fd}`)===log&&String(data).includes('"type":"revision"'))throw new Error('synthetic accounting failure');return (native as any)(fd,data,...args);}) as typeof fs.writeSync;syncBuiltinESMExports();
  try {assert.throws(()=>r.session.record([{role:'assistant',text:'NEW'}]),/synthetic accounting failure/);r.session.close();}
  finally {fs.writeSync=native;syncBuiltinESMExports();}
  armCrash('before-wc');assert.throws(()=>openSession({...f,sessionId:'S1',runner:'test',hardLimit:10000}),/injected crash/);armCrash(null);
  const retry=openSession({...f,sessionId:'S1',runner:'test',hardLimit:10000});assert.equal(retry.status,'open');assert.match(retry.session.sync().receipt?.text??'',/recovered the Event Log accounting/);assert.equal(retry.session.sync().receipt,undefined);retry.session.close();assert.equal([...readLog(log)].filter(e=>e.type==='revision'&&e.rev===2).length,1);
});

test('wave13: same-object accounting retry combines retained edit and recovery notices',()=>{
  const f=fixture(),r=openSession({...f,sessionId:'S1',runner:'test',hardLimit:10000});assert.equal(r.status,'open');r.session.record([{role:'user',text:'ORIGINAL'}]);const log=join(r.session.stateDir,'events.jsonl');fs.writeFileSync(r.session.workingContextPath,'CURATED EDIT');const native=fs.writeSync;
  fs.writeSync=((fd:number,data:any,...args:any[])=>{const line=String(data);if(fs.readlinkSync(`/proc/self/fd/${fd}`)===log&&line.includes('"type":"revision"')&&line.includes('"kind":"runner-append"'))throw new Error('synthetic append accounting failure');return (native as any)(fd,data,...args);}) as typeof fs.writeSync;syncBuiltinESMExports();
  try {assert.throws(()=>r.session.record([{role:'assistant',text:'FOLLOWUP'}]),/synthetic append accounting failure/);}
  finally {fs.writeSync=native;syncBuiltinESMExports();}
  const result=r.session.sync();assert.match(result.receipt?.text??'',/edit committed as revision 2/);assert.match(result.receipt?.text??'',/recovered.*revision 3/);r.session.close();
});

test('wave13: conflicting revision accounting refuses instead of suppressing recovery',()=>{
  const f=fixture(),r=openSession({...f,sessionId:'S1',runner:'test',hardLimit:10000,budgetTokens:1000});assert.equal(r.status,'open');r.session.record([{role:'user',text:'ORIGINAL'}]);const log=join(r.session.stateDir,'events.jsonl'),wc=r.session.workingContextPath;r.session.close();const before=fs.readFileSync(wc);
  const rows=fs.readFileSync(log,'utf8').trim().split('\n').map(line=>JSON.parse(line));for(const row of rows)if(row.type==='revision')row.chars++;
  fs.writeFileSync(log,rows.map(row=>JSON.stringify(row)).join('\n')+'\n');assert.throws(()=>openSession({...f,sessionId:'S1',runner:'test',hardLimit:10000,budgetTokens:1000}),/accounting metadata conflicts/);assert.deepEqual(fs.readFileSync(wc),before);
});

test('wave13: relative HOME fails before deriving a relative state tree',()=>{
  assert.throws(()=>resolveStateRoot(undefined,{HOME:'relative-home'}),/HOME.*absolute|state root.*absolute/);
  assert.equal(resolveStateRoot(undefined,{HOME:'relative-home',XDG_STATE_HOME:'/absolute-state'}),'/absolute-state/context-engine');assert.equal(resolveStateRoot('/explicit-state',{HOME:'relative-home'}),'/explicit-state');
});
