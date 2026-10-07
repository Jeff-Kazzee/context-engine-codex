import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {join} from 'node:path';
import {fixture} from './testing.ts';
import {armCrash} from './faults.ts';
import {openSession} from './index.ts';
import {appendLog,layout} from './store.ts';
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
