import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join, dirname } from 'node:path';
import { fixture } from './testing.ts';
import { openSession } from './index.ts';
import { appendLog } from './store.ts';
import { SNAPSHOT_MAX_BYTES } from './session.ts';

function opened() {
  const f=fixture(), r=openSession({...f,sessionId:'S1',runner:'test',hardLimit:10000});
  assert.equal(r.status,'open'); r.session.record([{role:'user',text:'ORIGINAL'}]);
  return {f,s:r.session};
}
for(const replace of [false,true]) test('wave20: oversized '+(replace?'native compaction':'runner batch')+' is refused before logging and remains recoverable',()=>{
  const {f,s}=opened(), log=join(s.stateDir,'events.jsonl'), head=join(s.stateDir,'HEAD');
  const before=fs.readFileSync(log), beforeHead=fs.readFileSync(head), original=Buffer.byteLength;
  // Inject the byte-limit outcome without allocating a 64 MiB batch on a shared host.
  Buffer.byteLength=((value:any,...args:any[])=>typeof value==='string'&&value.includes('OVERSIZED_BATCH')?SNAPSHOT_MAX_BYTES+1:(original as any)(value,...args)) as typeof Buffer.byteLength;
  try {assert.throws(()=>replace?s.nativeCompaction([{role:'user',text:'OVERSIZED_BATCH'}]):s.record([{role:'user',text:'OVERSIZED_BATCH'}]),/snapshot.*limit/);}
  finally {Buffer.byteLength=original;}
  assert.deepEqual(fs.readFileSync(log),before); assert.deepEqual(fs.readFileSync(head),beforeHead);
  s.record([{role:'user',text:'FOLLOWUP'}]); s.close();
  const r=openSession({...f,sessionId:'S1',runner:'test',hardLimit:10000});assert.equal(r.status,'open');
  assert.ok(r.session.sync().workingContextText.includes('FOLLOWUP'));r.session.close();
});
for(const replace of [false,true]) for(const sparse of [new Array(1),[, {role:'user',text:'VALID_AFTER_HOLE'}]]) test('wave20: sparse '+(replace?'compaction':'record')+' array refuses before mutation, length '+sparse.length,()=>{
  const {s}=opened(),log=join(s.stateDir,'events.jsonl'),before=fs.readFileSync(log),head=fs.readFileSync(join(s.stateDir,'HEAD'));
  assert.throws(()=>replace?s.nativeCompaction(sparse as any):s.record(sparse as any),/array.*events/);
  assert.deepEqual(fs.readFileSync(log),before);assert.deepEqual(fs.readFileSync(join(s.stateDir,'HEAD')),head);
  s.record([{role:'user',text:'AFTER_REJECTION'}]);assert.ok(s.sync().workingContextText.includes('AFTER_REJECTION'));s.close();
});
test('wave20: first Event Log creation flushes file then verified parent before append returns',()=>{
  const {s}=opened(),file=join(s.stateDir,'new-events.jsonl'),native=fs.fsyncSync,seen:string[]=[];
  fs.fsyncSync=((fd:number)=>{seen.push(fs.realpathSync(`/proc/self/fd/${fd}`));native(fd);}) as typeof fs.fsyncSync;syncBuiltinESMExports();
  try {appendLog(file,{type:'fixture'});}finally {fs.fsyncSync=native;syncBuiltinESMExports();}
  assert.ok(seen.indexOf(file)>=0);assert.ok(seen.lastIndexOf(dirname(file))>seen.indexOf(file));s.close();
});
test('wave20: a small replacement remains admissible when appending it to the old context would exceed the cap',()=>{
 const {s}=opened();s.record([{role:'user',text:'OLD_LARGE'}]);const original=Buffer.byteLength;
 Buffer.byteLength=((value:any,...args:any[])=>typeof value==='string'&&value.includes('OLD_LARGE')&&value.includes('SMALL_SUMMARY')?SNAPSHOT_MAX_BYTES+1:(original as any)(value,...args)) as typeof Buffer.byteLength;
 try {assert.throws(()=>s.record([{role:'assistant',text:'SMALL_SUMMARY'}]),/snapshot.*limit/);assert.doesNotThrow(()=>s.nativeCompaction([{role:'assistant',text:'SMALL_SUMMARY'}]));}
 finally {Buffer.byteLength=original;}
 assert.ok(!s.sync().workingContextText.includes('OLD_LARGE'));s.close();
});

test('wave20: an ambiguous durable append refuses in-place retry and recovers once after reopening',()=>{
 const {f,s}=opened(),log=join(s.stateDir,'events.jsonl'),before=fs.readFileSync(log),native=fs.fsyncSync;
 let fileFlushed=false,failed=false;
 fs.fsyncSync=((fd:number)=>{const path=fs.realpathSync(`/proc/self/fd/${fd}`);if(path===log)fileFlushed=true;if(fileFlushed&&!failed&&path===s.stateDir){failed=true;throw Object.assign(new Error('fixture directory flush failure'),{code:'EIO'});}native(fd);}) as typeof fs.fsyncSync;syncBuiltinESMExports();
 try {assert.throws(()=>s.record([{role:'user',text:'AMBIGUOUS_ONCE'}]),/fixture directory flush/);}
 finally {fs.fsyncSync=native;syncBuiltinESMExports();}
 assert.ok(failed);const after=fs.readFileSync(log);assert.ok(after.length>before.length);
 assert.throws(()=>s.record([{role:'user',text:'AMBIGUOUS_ONCE'}]),/close and reopen/);assert.throws(()=>s.sync(),/close and reopen/);assert.deepEqual(fs.readFileSync(log),after);s.close();
 const r=openSession({...f,sessionId:'S1',runner:'test',hardLimit:10000});assert.equal(r.status,'open');
 assert.equal(r.session.sync().workingContextText.match(/AMBIGUOUS_ONCE/g)?.length,1);r.session.record([{role:'user',text:'AFTER_REOPEN'}]);r.session.close();
});

test('wave20: failed append lease release also poisons retry until exactly-once recovery',()=>{
 const {f,s}=opened(),log=join(s.stateDir,'events.jsonl'),native=fs.unlinkSync;let failed=false;
 fs.unlinkSync=((path:any)=>{if(!failed&&String(path).endsWith('events.jsonl.append.lock')){failed=true;throw Object.assign(new Error('fixture lease release failure'),{code:'EIO'});}native(path);}) as typeof fs.unlinkSync;syncBuiltinESMExports();
 try {assert.throws(()=>s.record([{role:'user',text:'LEASE_RELEASE_ONCE'}]),/fixture lease release/);}
 finally {fs.unlinkSync=native;syncBuiltinESMExports();}
 assert.ok(failed);const after=fs.readFileSync(log);assert.throws(()=>s.record([{role:'user',text:'LEASE_RELEASE_ONCE'}]),/close and reopen/);assert.deepEqual(fs.readFileSync(log),after);
 // The fixture's failed unlink retained this test process's own lease.
 fs.unlinkSync(log+'.append.lock');s.close();
 const r=openSession({...f,sessionId:'S1',runner:'test',hardLimit:10000});assert.equal(r.status,'open');assert.equal(r.session.sync().workingContextText.match(/LEASE_RELEASE_ONCE/g)?.length,1);r.session.close();
});
