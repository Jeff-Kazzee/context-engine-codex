import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { fixture, tempDir } from './testing.ts';
import { inspectSession, openSession, setParticipation, show } from './index.ts';
import { appendLog } from './store.ts';

test('wave11: oversized HEAD refuses before any payload read', () => {
  const f=fixture(), r=openSession({...f,sessionId:'S1',runner:'test',hardLimit:10000});
  assert.equal(r.status,'open'); r.session.record([{role:'user',text:'ORIGINAL'}]);const head=join(r.session.stateDir,'HEAD');r.session.close();
  fs.truncateSync(head,32*1024*1024);
  const native=fs.readSync; let reads=0;
  fs.readSync=((fd:number,...args:any[])=>{if(fs.readlinkSync(`/proc/self/fd/${fd}`)===head)reads++;return (native as any)(fd,...args);}) as typeof fs.readSync;
  syncBuiltinESMExports();
  try { assert.throws(()=>inspectSession({...f,sessionId:'S1'}),/size limit|read limit/);assert.equal(reads,0); }
  finally {fs.readSync=native;syncBuiltinESMExports();}
});

test('wave11: oversized non-text show metadata refuses before accounting',()=>{
  const f=fixture(),r=openSession({...f,sessionId:'S1',runner:'test',hardLimit:10000});assert.equal(r.status,'open');
  const log=join(r.session.stateDir,'events.jsonl');r.session.close();
  appendLog(log,{type:'runner-events',events:[{seq:1,event:{role:'role'.repeat(10000),text:'SAFE'}}]});
  const before=fs.readFileSync(log);
  assert.throws(()=>show({...f,sessionId:'S1',id:'e1'}),/show metadata exceeds/);
  assert.deepEqual(fs.readFileSync(log),before);
});

test('wave11: first participation publication flushes every new directory parent',()=>{
  const ancestor=tempDir('new-state-ancestor'),root=join(ancestor,'missing','state'),projectRoot=tempDir('project');
  const native=fs.fsyncSync,flushed:string[]=[];
  fs.fsyncSync=((fd:number)=>{if(fs.fstatSync(fd).isDirectory())flushed.push(fs.realpathSync(`/proc/self/fd/${fd}`));native(fd);}) as typeof fs.fsyncSync;
  syncBuiltinESMExports();
  try {setParticipation({projectRoot,stateDir:root,state:'on'});}
  finally {fs.fsyncSync=native;syncBuiltinESMExports();}
  for(const parent of [ancestor,dirname(root),root])assert.ok(flushed.includes(parent),`missing durable parent ${parent}`);
});

test('wave11: failed new-root parent flush cannot report participation enabled',()=>{
  const ancestor=tempDir('state-flush-failure'),root=join(ancestor,'missing','state'),projectRoot=tempDir('project');
  const native=fs.fsyncSync;let failed=false;
  fs.fsyncSync=((fd:number)=>{if(!failed&&fs.fstatSync(fd).isDirectory()&&fs.realpathSync(`/proc/self/fd/${fd}`)===ancestor){failed=true;throw new Error('synthetic new-root parent flush failure');}native(fd);}) as typeof fs.fsyncSync;
  syncBuiltinESMExports();
  try {assert.throws(()=>setParticipation({projectRoot,stateDir:root,state:'on'}),/synthetic new-root parent flush failure/);}
  finally {fs.fsyncSync=native;syncBuiltinESMExports();}
  assert.equal(failed,true);assert.equal(fs.existsSync(join(root,'participation')),false);
});
