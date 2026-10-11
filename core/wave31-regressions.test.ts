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

/** The test's view of the operation index: a head and shards chosen by a digest of the ID. */
const indexShards=(state:string)=>fs.readdirSync(state).filter(name=>/^operations-[0-9a-f]{2}\.jsonl$/.test(name)).sort();
/** The committed index lines. Bytes past a shard's committed length are not part of the index. */
const indexedText=(state:string)=>Object.entries(JSON.parse(fs.readFileSync(join(state,'operations.json'),'utf8')).shards as Record<string,{bytes:number}>)
  .filter(([,shard])=>shard.bytes>0)
  .map(([name,shard])=>fs.readFileSync(join(state,name)).subarray(0,shard.bytes).toString('utf8')).join('');
const shardName=(id:string)=>`operations-${(parseInt(sha(id).slice(0,2),16)>>2).toString(16).padStart(2,'0')}.jsonl`;
/** Appends a line to an ID's shard and commits it in the head, as the index itself would. */
function commitIndexLine(state:string,id:string,line:string,through:number){
  const headPath=join(state,'operations.json'),head=JSON.parse(fs.readFileSync(headPath,'utf8')),name=shardName(id),shard=join(state,name);
  const bytes=head.shards[name]?.bytes??0,committed=fs.existsSync(shard)?fs.readFileSync(shard).subarray(0,bytes):Buffer.alloc(0);
  fs.writeFileSync(shard,Buffer.concat([committed,Buffer.from(line)]),{mode:0o600});
  const grown=Buffer.concat([committed,Buffer.from(line)]);
  head.shards[name]={bytes:grown.length,sha:sha(grown.toString('utf8'))};head.through=through;
  fs.writeFileSync(headPath,JSON.stringify(head),{mode:0o600});
}

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
  const state=first.session.stateDir,inodes=new Map(indexShards(state).map(name=>[name,fs.statSync(join(state,name)).ino]));
  const events=[{role:'user',text:'CRASHED_BEFORE_INDEX'}],operationId='00000000-0000-4000-8000-000000000403';
  armCrash('after-log');assert.throws(()=>first.session.record(events,{operationId}),/injected crash/);
  assert.equal(indexedText(state).includes(operationId),false);
  let session=first.session;
  if(reopen){session.close();const next=openSession(options);assert.equal(next.status,'open');session=next.session;}
  assert.equal(session.record(events,{operationId}).workingContextText.match(/CRASHED_BEFORE_INDEX/g)?.length,1);
  const log=fs.readFileSync(join(session.stateDir,'events.jsonl'),'utf8');
  assert.equal(log.split('\n').filter(line=>line.includes(operationId)).length,1);
  // The tail scan extends the existing index instead of rebuilding it.
  assert.ok(inodes.size>0);
  for(const [name,inode] of inodes)assert.equal(fs.statSync(join(state,name)).ino,inode);
  assert.equal(indexedText(state).includes(operationId),true);
  session.close();
});

for(const damage of ['missing','torn','malformed','mismatched','ahead'] as const)test('wave31: operation index damage ('+damage+') is repaired from the Event Log',()=>{
  const f=fixture(),options={...f,sessionId:'W31-DAMAGE',runner:'test',hardLimit:10000};
  const earlier='00000000-0000-4000-8000-000000000501',operationId='00000000-0000-4000-8000-000000000502',event={role:'user',text:'INDEXED_ONCE'};
  const first=openSession(options);assert.equal(first.status,'open');
  first.session.record([{role:'user',text:'EARLIER_INPUT'}],{operationId:earlier});
  first.session.record([event],{operationId});
  const state=first.session.stateDir,headPath=join(state,'operations.json');first.session.close();
  if(damage==='missing')fs.rmSync(headPath);
  else if(damage==='torn')for(const name of indexShards(state))fs.appendFileSync(join(state,name),'{"id":"'+operationId);
  else if(damage==='malformed')fs.writeFileSync(headPath,'{"through":');
  else if(damage==='ahead')fs.writeFileSync(headPath,JSON.stringify({...JSON.parse(fs.readFileSync(headPath,'utf8')),through:Number.MAX_SAFE_INTEGER}));
  else {
    // Give the entry another row's digest at the same length. The check against its own row must reject it.
    const digest=(id:string)=>JSON.parse(indexedText(state).split('\n').find(line=>line.includes(id))!).sha,shard=join(state,shardName(operationId));
    fs.writeFileSync(shard,fs.readFileSync(shard,'utf8').replace(digest(operationId),digest(earlier)));
  }
  const next=openSession(options);assert.equal(next.status,'open');
  next.session.record([event],{operationId});
  assert.equal(next.session.sync().workingContextText.match(/INDEXED_ONCE/g)?.length,1);
  assert.throws(()=>next.session.record([{role:'user',text:'CHANGED_INPUT'}],{operationId}),/operation.*different/i);
  next.session.record([{role:'user',text:'AFTER_REPAIR'}],{operationId:'00000000-0000-4000-8000-000000000503'});
  next.session.close();
  JSON.parse(fs.readFileSync(headPath,'utf8'));
  for(const line of indexedText(state).trim().split('\n'))JSON.parse(line);
});

for(const staleEntry of [false,true])test('wave31: a torn identified row is never claimed, staleEntry='+staleEntry,()=>{
  const f=fixture(),options={...f,sessionId:'W31-TORN',runner:'test',hardLimit:10000};
  const first=openSession(options);assert.equal(first.status,'open');
  first.session.record([{role:'user',text:'BEFORE_TORN_ONE'}],{operationId:'00000000-0000-4000-8000-000000000601'});
  first.session.record([{role:'user',text:'BEFORE_TORN_TWO'}],{operationId:'00000000-0000-4000-8000-000000000602'});
  const state=first.session.stateDir,log=join(state,'events.jsonl');
  const events=[{role:'user',text:'TORN_ONCE'}],operationId='00000000-0000-4000-8000-000000000603';
  armCrash('log-torn');assert.throws(()=>first.session.record(events,{operationId}),/injected crash/);
  assert.equal(indexedText(state).includes(operationId),false);
  if(staleEntry){
    // The worst case after storage loss: a committed index entry that names the torn bytes as a durable row.
    const bytes=fs.readFileSync(log),start=bytes.lastIndexOf(0x0a)+1;
    commitIndexLine(state,operationId,JSON.stringify({id:operationId,sha:sha(JSON.stringify(events.map(retainRunnerEvent))),start,end:bytes.length})+'\n',bytes.length);
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
  const state=first.session.stateDir,log=join(state,'events.jsonl');
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
  assert.equal(indexedText(state).includes(operationId),false);
  assert.throws(()=>first.session.record(events,{operationId}),/close and reopen/);
  first.session.close();
  const next=openSession(options);assert.equal(next.status,'open');
  next.session.record(events,{operationId});
  assert.equal(next.session.sync().workingContextText.match(/AMBIGUOUS_ONCE/g)?.length,1);
  assert.equal(fs.readFileSync(log,'utf8').split('\n').filter(line=>line.includes(operationId)).length,1);
  assert.equal(indexedText(state).includes(operationId),true);
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

/** One open, identified record and close, as one CLI call does. */
function recordOnce(options:{projectRoot:string;stateDir:string;sessionId:string;runner:string;hardLimit:number},text:string,operationId?:string){
  const o=openSession(options);assert.equal(o.status,'open');
  try{o.session.record([{role:'tool',text}],operationId?{operationId}:undefined);}finally{o.session.close();}
}
const rowsWith=(log:string,marker:string)=>fs.readFileSync(log,'utf8').split('\n').filter(line=>line.includes('"runner-events"')&&line.includes(marker)).length;

test('wave31: an operation index that covers more than a shortened Event Log is rebuilt',()=>{
  const options={...fixture(),sessionId:'W31-OFFSET',runner:'test',hardLimit:1_000_000},p=layout(options.projectRoot,options.sessionId,options.stateDir);
  recordOnce(options,'KEEP_ONE','00000000-0000-4000-8000-000000001001');
  const cut=fs.statSync(p.events).size,head=fs.readFileSync(p.head),wc=fs.readFileSync(p.workingContext),revisions=new Set(fs.readdirSync(p.revisions));
  recordOnce(options,'LOST_TWO '+'l'.repeat(4000),'00000000-0000-4000-8000-000000001002');
  // The index covers the log through the end of the second identified row.
  const bytes=fs.readFileSync(p.events),at=bytes.indexOf('LOST_TWO'),covered=bytes.indexOf(0x0a,at)+1;
  // A storage revert loses that record. HEAD, revisions and the Working Context return to the cut.
  fs.truncateSync(p.events,cut);fs.writeFileSync(p.head,head);fs.writeFileSync(p.workingContext,wc);
  for(const name of fs.readdirSync(p.revisions))if(!revisions.has(name))fs.rmSync(join(p.revisions,name));
  fs.rmSync(join(p.stateDir,'recovery.json'),{force:true});
  recordOnce(options,'AFTER_LOSS','00000000-0000-4000-8000-000000001003');
  // The log regrows to exactly the old covered offset, so the new identified row sits below it.
  const base=Buffer.byteLength(JSON.stringify({type:'test-pad',p:'',at:new Date().toISOString()}))+1,size=fs.statSync(p.events).size;
  assert.ok(covered-size-base>=0);
  appendLog(p.events,{type:'test-pad',p:'p'.repeat(covered-size-base)});
  assert.equal(fs.statSync(p.events).size,covered);
  recordOnce(options,'AFTER_LOSS','00000000-0000-4000-8000-000000001003');
  assert.equal(rowsWith(p.events,'AFTER_LOSS'),1);
});

test('wave31: an operation index bound to a replaced Event Log is rebuilt',()=>{
  const options={...fixture(),sessionId:'W31-INODE',runner:'test',hardLimit:1_000_000},p=layout(options.projectRoot,options.sessionId,options.stateDir);
  recordOnce(options,'WARM_ZERO','00000000-0000-4000-8000-000000002000');
  recordOnce(options,'BASE_ONE','00000000-0000-4000-8000-000000002001');
  // An unidentified row, then an identified one, so the index covers the unidentified row.
  const text='UNSEEN_ROW '+'u'.repeat(200);
  recordOnce(options,text+'v'.repeat(131));
  recordOnce(options,'BASE_THREE','00000000-0000-4000-8000-000000002003');
  // The replacement log carries an identified row of the same length where the unidentified row was.
  const operationId='00000000-0000-4000-8000-000000002002',lines=fs.readFileSync(p.events,'utf8').split('\n');
  const index=lines.findIndex(line=>line.includes('UNSEEN_ROW')),row=JSON.parse(lines[index]!),event={role:'tool',text};
  const replacement=JSON.stringify({type:row.type,events:[{seq:row.events[0].seq,event}],operation:{id:operationId,sha:sha(JSON.stringify([event]))},at:row.at});
  assert.equal(replacement.length,lines[index]!.length);
  lines[index]=replacement;
  const copy=p.events+'.replacement';
  fs.writeFileSync(copy,lines.join('\n'),{mode:0o600});fs.renameSync(copy,p.events);
  recordOnce(options,text,operationId);
  assert.equal(rowsWith(p.events,operationId),1);
});

for(const inflate of ['every index file','only the shards'] as const)test('wave31: index files above their size bound are never loaded, inflating '+inflate,()=>{
  const options={...fixture(),sessionId:'W31-BOUND',runner:'test',hardLimit:1_000_000},p=layout(options.projectRoot,options.sessionId,options.stateDir);
  recordOnce(options,'BOUND_ONE','00000000-0000-4000-8000-000000003001');
  recordOnce(options,'BOUND_TWO','00000000-0000-4000-8000-000000003002');
  // Inflate index files far past any bound a lookup may load. Leaving the head intact makes the shard read its own test.
  const files=fs.readdirSync(p.stateDir).filter(name=>name.startsWith('operations')&&!name.includes('.lock')&&(inflate==='every index file'||/^operations-[0-9a-f]{2}\.jsonl$/.test(name)));
  assert.ok(files.length>0);
  for(const name of files)fs.appendFileSync(join(p.stateDir,name),Buffer.alloc(32*1024*1024,0x78));
  // Count the index bytes read while an exact retry and a new operation are recorded.
  const read=fs.readSync,readFile=fs.readFileSync;let indexBytes=0;
  const isIndex=(target:unknown)=>typeof target==='number'&&/\/operations[^/]*$/.test(fs.realpathSync(`/proc/self/fd/${target}`));
  fs.readSync=((fd:number,...args:any[])=>{const n=(read as any)(fd,...args);if(isIndex(fd))indexBytes+=n;return n;}) as typeof fs.readSync;
  fs.readFileSync=((target:any,...args:any[])=>{const out=(readFile as any)(target,...args);if(isIndex(target))indexBytes+=out.length;return out;}) as typeof fs.readFileSync;
  syncBuiltinESMExports();
  try{
    recordOnce(options,'BOUND_TWO','00000000-0000-4000-8000-000000003002');
    recordOnce(options,'BOUND_THREE','00000000-0000-4000-8000-000000003003');
  }finally{fs.readSync=read;fs.readFileSync=readFile;syncBuiltinESMExports();}
  assert.ok(indexBytes<1024*1024,`read ${indexBytes} index bytes`);
  assert.equal(rowsWith(p.events,'BOUND_TWO'),1);
  assert.equal(rowsWith(p.events,'BOUND_THREE'),1);
});

for(const damage of ['omitted','replaced'] as const)test('wave31: an index shard with one '+damage+' entry is never trusted for a miss',()=>{
  const options={...fixture(),sessionId:'W31-COMPLETE',runner:'test',hardLimit:1_000_000},p=layout(options.projectRoot,options.sessionId,options.stateDir);
  const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
  // Three IDs in one shard, so the damaged entry sits between two others.
  const name=shardName(id(5000)),ids=[id(5000)];
  for(let n=5001;ids.length<3;n++)if(shardName(id(n))===name)ids.push(id(n));
  for(const [i,operationId] of ids.entries())recordOnce(options,`COMPLETE_${i}`,operationId);
  const target=ids[1]!,shard=join(p.stateDir,name),headPath=join(p.stateDir,'operations.json');
  const text=fs.readFileSync(shard,'utf8'),line=text.split('\n').find(entry=>entry.includes(target))!+'\n';
  if(damage==='omitted'){
    // The shard and its committed length look as if the entry had never been written.
    const head=JSON.parse(fs.readFileSync(headPath,'utf8'));head.shards[name].bytes-=line.length;
    fs.writeFileSync(shard,text.replace(line,''));fs.writeFileSync(headPath,JSON.stringify(head));
  } else fs.writeFileSync(shard,text.replace(target,id(9999)));
  recordOnce(options,'COMPLETE_1',target);
  assert.equal(rowsWith(p.events,'COMPLETE_1'),1);
});

test('wave31: an index entry whose row a storage revert removed is never claimed',()=>{
  const options={...fixture(),sessionId:'W31-LOSTHIT',runner:'test',hardLimit:1_000_000},p=layout(options.projectRoot,options.sessionId,options.stateDir);
  recordOnce(options,'KEEP_FIRST','00000000-0000-4000-8000-000000007001');
  recordOnce(options,'KEEP_SECOND','00000000-0000-4000-8000-000000007002');
  const cut=fs.statSync(p.events).size,head=fs.readFileSync(p.head),wc=fs.readFileSync(p.workingContext),revisions=new Set(fs.readdirSync(p.revisions));
  const lost='LOST_ROW '+'l'.repeat(2000),operationId='00000000-0000-4000-8000-000000007003';
  recordOnce(options,lost,operationId);
  const bytes=fs.readFileSync(p.events),covered=bytes.indexOf(0x0a,bytes.indexOf('LOST_ROW'))+1;
  // A storage revert loses the record but keeps the index entry that names it.
  fs.truncateSync(p.events,cut);fs.writeFileSync(p.head,head);fs.writeFileSync(p.workingContext,wc);
  for(const name of fs.readdirSync(p.revisions))if(!revisions.has(name))fs.rmSync(join(p.revisions,name));
  fs.rmSync(join(p.stateDir,'recovery.json'),{force:true});
  // The log regrows to exactly the covered offset, so the head, offset and shard digest all still pass.
  const base=Buffer.byteLength(JSON.stringify({type:'test-pad',p:'',at:new Date().toISOString()}))+1;
  appendLog(p.events,{type:'test-pad',p:'p'.repeat(covered-cut-base)});
  assert.equal(fs.statSync(p.events).size,covered);
  recordOnce(options,lost,operationId);
  assert.equal(rowsWith(p.events,'LOST_ROW'),1);
});

test('wave31: omitted shard metadata cannot turn an exact retry into a new operation',()=>{
  const options={...fixture(),sessionId:'W31-MISSING-SHARD',runner:'test',hardLimit:1_000_000};
  const p=layout(options.projectRoot,options.sessionId,options.stateDir);
  const first='00000000-0000-4000-8000-000000008101',second='00000000-0000-4000-8000-000000008102';
  recordOnce(options,'MISSING_SHARD_ONCE',first);
  recordOnce(options,'LATER_RECORD',second);
  const path=join(p.stateDir,'operations.json'),head=JSON.parse(fs.readFileSync(path,'utf8'));
  assert.ok(head.shards[shardName(first)]);
  delete head.shards[shardName(first)];
  fs.writeFileSync(path,JSON.stringify(head));
  recordOnce(options,'MISSING_SHARD_ONCE',first);
  assert.equal(rowsWith(p.events,'MISSING_SHARD_ONCE'),1);
});

test('wave31: retries persist tail coverage when no identified rows were appended',t=>{
  const options={...fixture(),sessionId:'W31-TAIL-COVERAGE',runner:'test',hardLimit:1_000_000};
  const opened=openSession(options);assert.equal(opened.status,'open');
  const session=opened.session,operationId='00000000-0000-4000-8000-000000008201';
  const event={role:'tool',text:'TAIL_RETRY_ONCE'},log=join(session.stateDir,'events.jsonl');
  try {
    session.record([event],{operationId});
    session.record([{role:'tool',text:'SECOND_IDENTIFIED'}],{operationId:'00000000-0000-4000-8000-000000008202'});
    for(let i=0;i<12;i++)appendLog(log,{type:'recall',query:'history',note:'x'.repeat(8192)});
    const through=fs.statSync(log).size;
    session.record([event],{operationId});
    const head=JSON.parse(fs.readFileSync(join(session.stateDir,'operations.json'),'utf8'));
    assert.equal(head.through,through,'the completed tail scan is durable even without a new index entry');
    const native=fs.readSync;let logBytes=0;
    const spy=t.mock.method(fs,'readSync',(...args:unknown[])=>{
      const n:number=Reflect.apply(native,fs,args),fd=args[0];
      if(typeof fd==='number'&&fs.realpathSync(`/proc/self/fd/${fd}`)===log)logBytes+=n;
      return n;
    });
    syncBuiltinESMExports();
    try{session.record([event],{operationId});}
    finally{spy.mock.restore();syncBuiltinESMExports();}
    assert.ok(logBytes<=64*1024,`the next retry read ${logBytes} bytes after the tail was already covered`);
    assert.equal(rowsWith(log,'TAIL_RETRY_ONCE'),1);
  } finally {session.close();}
});
