import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {fixture} from './testing.ts';
import {armCrash} from './faults.ts';
import {openSession} from './index.ts';
import {appendLog,layout,sha} from './store.ts';
import {retainRunnerEvent} from './event-safety.ts';
import {acquireLock,holderFor,releaseLock} from './lock.ts';

test('wave31: close releases ownership when receipt confirmation fails', () => {
  const f = fixture(), options = {...f, sessionId:'W31', runner:'test', hardLimit:10000};
  const initial = openSession(options); assert.equal(initial.status,'open');
  initial.session.record([{role:'user',text:'CLOSE_SENTINEL'}]);
  const log = join(initial.session.stateDir,'events.jsonl'); initial.session.close();
  const row = fs.readFileSync(log,'utf8').trim().split('\n').map(line=>JSON.parse(line)).find(row=>row.type==='revision');
  appendLog(log,{...row,recovered:true});
  const reopened = openSession(options); assert.equal(reopened.status,'open');
  assert.match(reopened.session.sync().receipt?.text ?? '',/recovered/);
  const write = fs.writeSync;
  fs.writeSync = ((fd:number,data:any,...args:any[]) => {
    if(String(data).includes('"type":"revision-receipt-return-confirmed"')) throw new Error('SYNTHETIC_CONFIRMATION_FAILURE');
    return (write as any)(fd,data,...args);
  }) as typeof fs.writeSync; syncBuiltinESMExports();
  try { assert.throws(()=>reopened.session.close(),/SYNTHETIC_CONFIRMATION_FAILURE/); }
  finally { fs.writeSync=write; syncBuiltinESMExports(); }
  const lock = layout(f.projectRoot,'W31',f.stateDir).lock;
  const contender = holderFor(99999999,'contender',10000);
  try { assert.equal(acquireLock(lock,contender).status,'acquired'); }
  finally { releaseLock(lock,contender); }
  const retry = openSession(options); assert.equal(retry.status,'open');
  assert.match(retry.session.sync().receipt?.text ?? '',/recovered/); retry.session.close();
});

test('wave31: operation identity accepts an exact retry and refuses changed input', () => {
  const f=fixture(), options={...f,sessionId:'W31-ID',runner:'test',hardLimit:10000};
  const first=openSession(options); assert.equal(first.status,'open');
  const operationId='00000000-0000-4000-8000-000000000001', event={role:'user',text:'REPEATED_INPUT'};
  first.session.record([event],{operationId}); first.session.close();
  const next=openSession(options); assert.equal(next.status,'open');
  next.session.record([event],{operationId});
  assert.equal(next.session.sync().workingContextText.match(/REPEATED_INPUT/g)?.length,1);
  assert.throws(()=>next.session.record([{role:'user',text:'DIFFERENT_INPUT'}],{operationId}),/operation.*different/i);
  assert.throws(()=>next.session.record([event],{operationId:'invalid'}),/operation.*identifier/i);
  next.session.record([event],{operationId:'00000000-0000-4000-8000-000000000002'});
  assert.equal(next.session.sync().workingContextText.match(/REPEATED_INPUT/g)?.length,2); next.session.close();
});


for(const reopen of [false,true]) test('wave31: durable operation replays after interrupted publication, reopen='+reopen,()=>{
  const f=fixture(),options={...f,sessionId:'W31-REPLAY',runner:'test',hardLimit:10000};
  const first=openSession(options);assert.equal(first.status,'open');
  const events=[{role:'user',text:'REPLAY_ONCE'}],operationId='00000000-0000-4000-8000-000000000003';
  armCrash('after-log');assert.throws(()=>first.session.record(events,{operationId}),/injected crash/);
  let session=first.session;
  if(reopen){session.close();const next=openSession(options);assert.equal(next.status,'open');session=next.session;}
  assert.equal(session.record(events,{operationId}).workingContextText.match(/REPLAY_ONCE/g)?.length,1);
  const log=fs.readFileSync(join(session.stateDir,'events.jsonl'),'utf8');
  assert.equal(log.split('\n').filter(line=>line.includes('"type":"runner-events"')).length,1);session.close();
});

test('wave31: corrupt durable operation metadata refuses recovery',()=>{
  const f=fixture(),options={...f,sessionId:'W31-CORRUPT',runner:'test',hardLimit:10000};
  const r=openSession(options);assert.equal(r.status,'open');
  r.session.record([{role:'user',text:'VERIFIED_INPUT'}],{operationId:'00000000-0000-4000-8000-000000000004'});
  const log=join(r.session.stateDir,'events.jsonl');r.session.close();
  const entries=fs.readFileSync(log,'utf8').trim().split('\n').map(line=>JSON.parse(line));
  entries.find(row=>row.type==='runner-events').operation.sha='0'.repeat(64);
  fs.writeFileSync(log,entries.map(row=>JSON.stringify(row)).join('\n')+'\n');
  assert.throws(()=>openSession(options),/record operation metadata/);
});

test('wave31: a first-seen operation reads only the Event Log tail', () => {
  const f=fixture(),options={...f,sessionId:'W31-TAIL',runner:'test',hardLimit:4_000_000};
  const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
  const first=openSession(options);assert.equal(first.status,'open');
  for(let i=0;i<8;i++)first.session.record([{role:'tool',text:`BULK_${i} `+'x'.repeat(128*1024)}],{operationId:id(100+i)});
  const log=join(first.session.stateDir,'events.jsonl');first.session.close();
  const next=openSession(options);assert.equal(next.status,'open');
  // Count Event Log bytes read while one new identified operation is recorded.
  const read=fs.readSync;let logBytes=0;
  fs.readSync=((fd:number,...args:any[])=>{const n=(read as any)(fd,...args);if(fs.realpathSync(`/proc/self/fd/${fd}`)===log)logBytes+=n;return n;}) as typeof fs.readSync;syncBuiltinESMExports();
  try{next.session.record([{role:'tool',text:'FRESH_OPERATION'}],{operationId:id(200)});}
  finally{fs.readSync=read;syncBuiltinESMExports();}
  const size=fs.statSync(log).size;assert.ok(size>1024*1024);
  assert.ok(logBytes<64*1024,`read ${logBytes} of ${size} Event Log bytes for a first-seen operation`);
  next.session.record([{role:'tool',text:'FRESH_OPERATION'}],{operationId:id(200)});
  assert.equal(next.session.sync().workingContextText.match(/FRESH_OPERATION/g)?.length,1);
  assert.throws(()=>next.session.record([{role:'tool',text:'CHANGED_INPUT'}],{operationId:id(103)}),/operation.*different/i);
  next.session.close();
});

for(const reopen of [false,true])test('wave31: an operation logged before a crash is indexed from the log tail, reopen='+reopen,()=>{
  const f=fixture(),options={...f,sessionId:'W31-CATCHUP',runner:'test',hardLimit:10000};
  const first=openSession(options);assert.equal(first.status,'open');
  first.session.record([{role:'user',text:'BEFORE_ONE'}],{operationId:'00000000-0000-4000-8000-000000000401'});
  first.session.record([{role:'user',text:'BEFORE_TWO'}],{operationId:'00000000-0000-4000-8000-000000000402'});
  const index=join(first.session.stateDir,'operations.jsonl'),inode=fs.statSync(index).ino;
  const events=[{role:'user',text:'CRASHED_BEFORE_INDEX'}],operationId='00000000-0000-4000-8000-000000000403';
  armCrash('after-log');assert.throws(()=>first.session.record(events,{operationId}),/injected crash/);
  assert.equal(fs.readFileSync(index,'utf8').includes(operationId),false);
  let session=first.session;
  if(reopen){session.close();const next=openSession(options);assert.equal(next.status,'open');session=next.session;}
  assert.equal(session.record(events,{operationId}).workingContextText.match(/CRASHED_BEFORE_INDEX/g)?.length,1);
  const log=fs.readFileSync(join(session.stateDir,'events.jsonl'),'utf8');
  assert.equal(log.split('\n').filter(line=>line.includes(operationId)).length,1);
  // The tail scan extends the existing index instead of rebuilding it.
  assert.equal(fs.statSync(index).ino,inode);
  assert.equal(fs.readFileSync(index,'utf8').includes(operationId),true);
  session.close();
});

for(const damage of ['missing','torn','malformed','mismatched','ahead'] as const)test('wave31: operation index damage ('+damage+') is repaired from the Event Log',()=>{
  const f=fixture(),options={...f,sessionId:'W31-DAMAGE',runner:'test',hardLimit:10000};
  const earlier='00000000-0000-4000-8000-000000000501',operationId='00000000-0000-4000-8000-000000000502',event={role:'user',text:'INDEXED_ONCE'};
  const first=openSession(options);assert.equal(first.status,'open');
  first.session.record([{role:'user',text:'EARLIER_INPUT'}],{operationId:earlier});
  first.session.record([event],{operationId});
  const index=join(first.session.stateDir,'operations.jsonl');first.session.close();
  const lines=fs.readFileSync(index,'utf8').trim().split('\n').map(line=>JSON.parse(line));
  if(damage==='missing')fs.rmSync(index);
  else if(damage==='torn')fs.appendFileSync(index,'{"id":"'+operationId);
  else if(damage==='malformed')fs.appendFileSync(index,'{"through":\n');
  else if(damage==='ahead')fs.appendFileSync(index,JSON.stringify({through:Number.MAX_SAFE_INTEGER})+'\n');
  else {
    // Give the entry another row's digest. The check against its own row must reject it.
    const own=lines.find(line=>line.id===operationId),other=lines.find(line=>line.id===earlier);
    own.sha=other.sha;fs.writeFileSync(index,lines.map(line=>JSON.stringify(line)).join('\n')+'\n');
  }
  const next=openSession(options);assert.equal(next.status,'open');
  next.session.record([event],{operationId});
  assert.equal(next.session.sync().workingContextText.match(/INDEXED_ONCE/g)?.length,1);
  assert.throws(()=>next.session.record([{role:'user',text:'CHANGED_INPUT'}],{operationId}),/operation.*different/i);
  next.session.record([{role:'user',text:'AFTER_REPAIR'}],{operationId:'00000000-0000-4000-8000-000000000503'});
  next.session.close();
  for(const line of fs.readFileSync(index,'utf8').trim().split('\n'))JSON.parse(line);
});

for(const staleEntry of [false,true])test('wave31: a torn identified row is never claimed, staleEntry='+staleEntry,()=>{
  const f=fixture(),options={...f,sessionId:'W31-TORN',runner:'test',hardLimit:10000};
  const first=openSession(options);assert.equal(first.status,'open');
  first.session.record([{role:'user',text:'BEFORE_TORN_ONE'}],{operationId:'00000000-0000-4000-8000-000000000601'});
  first.session.record([{role:'user',text:'BEFORE_TORN_TWO'}],{operationId:'00000000-0000-4000-8000-000000000602'});
  const log=join(first.session.stateDir,'events.jsonl'),index=join(first.session.stateDir,'operations.jsonl');
  const events=[{role:'user',text:'TORN_ONCE'}],operationId='00000000-0000-4000-8000-000000000603';
  armCrash('log-torn');assert.throws(()=>first.session.record(events,{operationId}),/injected crash/);
  assert.equal(fs.readFileSync(index,'utf8').includes(operationId),false);
  if(staleEntry){
    // The worst case after storage loss: an index entry that names the torn bytes as a durable row.
    const bytes=fs.readFileSync(log),start=bytes.lastIndexOf(0x0a)+1;
    fs.appendFileSync(index,JSON.stringify({id:operationId,sha:sha(JSON.stringify(events.map(retainRunnerEvent))),start,end:bytes.length,through:bytes.length})+'\n');
  }
  first.session.close();
  const next=openSession(options);assert.equal(next.status,'open');
  next.session.record(events,{operationId});
  assert.equal(next.session.sync().workingContextText.match(/TORN_ONCE/g)?.length,1);
  assert.equal(fs.readFileSync(log,'utf8').split('\n').filter(line=>line.includes(operationId)).length,1);
  next.session.close();
});

test('wave31: an ambiguous identified append enters the index only after reopen',()=>{
  const f=fixture(),options={...f,sessionId:'W31-AMBIGUOUS',runner:'test',hardLimit:10000};
  const first=openSession(options);assert.equal(first.status,'open');
  first.session.record([{role:'user',text:'BEFORE_AMBIGUOUS_ONE'}],{operationId:'00000000-0000-4000-8000-000000000701'});
  first.session.record([{role:'user',text:'BEFORE_AMBIGUOUS_TWO'}],{operationId:'00000000-0000-4000-8000-000000000702'});
  const log=join(first.session.stateDir,'events.jsonl'),index=join(first.session.stateDir,'operations.jsonl');
  const events=[{role:'user',text:'AMBIGUOUS_ONCE'}],operationId='00000000-0000-4000-8000-000000000703';
  // The whole row is written, then its flush fails, so the append may or may not be durable.
  const native=fs.fsyncSync;let failed=false;
  fs.fsyncSync=((fd:number)=>{
    if(!failed&&fs.realpathSync(`/proc/self/fd/${fd}`)===log&&fs.readFileSync(log,'utf8').trimEnd().split('\n').at(-1)!.includes(operationId)){failed=true;throw Object.assign(new Error('fixture log flush failure'),{code:'EIO'});}
    native(fd);
  }) as typeof fs.fsyncSync;syncBuiltinESMExports();
  try{assert.throws(()=>first.session.record(events,{operationId}),/fixture log flush failure/);}
  finally{fs.fsyncSync=native;syncBuiltinESMExports();}
  assert.equal(failed,true);
  assert.equal(fs.readFileSync(index,'utf8').includes(operationId),false);
  assert.throws(()=>first.session.record(events,{operationId}),/close and reopen/);
  first.session.close();
  const next=openSession(options);assert.equal(next.status,'open');
  next.session.record(events,{operationId});
  assert.equal(next.session.sync().workingContextText.match(/AMBIGUOUS_ONCE/g)?.length,1);
  assert.equal(fs.readFileSync(log,'utf8').split('\n').filter(line=>line.includes(operationId)).length,1);
  assert.equal(fs.readFileSync(index,'utf8').includes(operationId),true);
  next.session.close();
});

test('wave31: an exact retry after many later operations is still claimed',()=>{
  const f=fixture(),options={...f,sessionId:'W31-LATE',runner:'test',hardLimit:100000};
  const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,event={role:'user',text:'LATE_RETRY_ONCE'};
  const first=openSession(options);assert.equal(first.status,'open');
  first.session.record([event],{operationId:id(800)});
  for(let i=1;i<=40;i++)first.session.record([{role:'tool',text:`LATER_${i}`}],{operationId:id(800+i)});
  first.session.close();
  const next=openSession(options);assert.equal(next.status,'open');
  next.session.record([event],{operationId:id(800)});
  assert.equal(next.session.sync().workingContextText.match(/LATE_RETRY_ONCE/g)?.length,1);
  assert.throws(()=>next.session.record([{role:'user',text:'LATE_CHANGED'}],{operationId:id(800)}),/operation.*different/i);
  next.session.close();
});

test('wave31: concurrent CLI calls with one operation ID append one row',async()=>{
  const f=fixture(),operationId='00000000-0000-4000-8000-000000000900',cli=fileURLToPath(new URL('./cli.ts',import.meta.url));
  const run=()=>new Promise<number|null>(resolve=>{
    const child=spawn(process.execPath,[cli,'record','--session','W31-LEASE','--project',f.projectRoot,'--runner','test','--hard-limit','10000','--owner-pid',String(process.pid),'--operation-id',operationId],{env:{...process.env,CONTEXT_ENGINE_STATE_DIR:f.stateDir},stdio:['pipe','ignore','ignore']});
    child.on('close',resolve);child.stdin.end(JSON.stringify([{role:'user',text:'LEASED_ONCE'}]));
  });
  assert.deepEqual(await Promise.all([run(),run(),run(),run()]),[0,0,0,0]);
  const log=layout(f.projectRoot,'W31-LEASE',f.stateDir).events;
  assert.equal(fs.readFileSync(log,'utf8').split('\n').filter(line=>line.includes(operationId)).length,1);
});
