import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { fixture, tempDir } from './testing.ts';
import { openSession } from './index.ts';
import { checkRefs, staleText } from './refs.ts';

test('wave16: hardLimit requires a positive safe integer before opening state',()=>{
  for(const hardLimit of [1.1,0,-1,NaN,Infinity,Number.MAX_SAFE_INTEGER+1]){
    const f=fixture();assert.throws(()=>openSession({...f,sessionId:'S1',runner:'test',hardLimit}),/hardLimit.*positive.*safe integer/);assert.equal(fs.existsSync(f.stateDir),false);
  }
  const r=openSession({...fixture(),sessionId:'S1',runner:'test',hardLimit:10000});assert.equal(r.status,'open');r.session.close();
});

test('wave16: distinct markers share one source read and finite marker work',()=>{
  const root=tempDir('refs-budget'),file=join(root,'source.ts');fs.writeFileSync(file,'SAFE\n');
  const native=fs.openSync;let opens=0;fs.openSync=((path:any,...args:any[])=>{if(String(path)===file)opens++;return (native as any)(path,...args);}) as typeof fs.openSync;syncBuiltinESMExports();
  try {const r=checkRefs(root,Array.from({length:200},(_,i)=>`⟦src:source.ts@${i.toString(16).padStart(8,'0')}⟧`).join('\n'));
    assert.ok(r);assert.equal((r as any).incomplete,true);assert.ok(r.count<=64);assert.equal(opens,1);assert.match(staleText(r),/incomplete|not checked/);
  }finally{fs.openSync=native;syncBuiltinESMExports();}
});

test('wave16: aggregate source bytes refuse before oversized payload allocation',()=>{
  const root=tempDir('refs-bytes'),file=join(root,'source.ts');fs.writeFileSync(file,'');fs.truncateSync(file,5*1024*1024);
  const native=fs.readSync;let reads=0;fs.readSync=((fd:number,...args:any[])=>{if(fs.realpathSync(`/proc/self/fd/${fd}`)===file)reads++;return (native as any)(fd,...args);}) as typeof fs.readSync;syncBuiltinESMExports();
  try{const r=checkRefs(root,'⟦src:source.ts@00000000⟧');assert.ok(r);assert.equal((r as any).incomplete,true);assert.equal(reads,0);assert.equal(r.count,0);assert.match(staleText(r),/incomplete/);}
  finally{fs.readSync=native;syncBuiltinESMExports();}
});

test('wave16: commit probes obey a shared bound and timeouts are incomplete, not missing',()=>{
  const root=tempDir('refs-git'),native=cp.spawnSync;let probes=0;
  cp.spawnSync=((...args:any[])=>{probes++;return {status:0,stdout:args[1]?.[0]==='rev-parse'?'true\n':'',stderr:'',pid:0,output:[],signal:null};}) as unknown as typeof cp.spawnSync;syncBuiltinESMExports();
  try{const r=checkRefs(root,Array.from({length:20},(_,i)=>`⟦commit:${i.toString(16).padStart(12,'0')}⟧`).join('\n'));assert.ok(r);assert.equal((r as any).incomplete,true);assert.ok(probes<=8);}
  finally{cp.spawnSync=native;syncBuiltinESMExports();}
  cp.spawnSync=((...args:any[])=>({status:null,stdout:'',stderr:'',pid:0,output:[],signal:'SIGTERM',error:Object.assign(new Error('synthetic deadline'),{code:'ETIMEDOUT'})})) as unknown as typeof cp.spawnSync;syncBuiltinESMExports();
  try{const r=checkRefs(root,'⟦commit:000000000001⟧');assert.ok(r);assert.equal((r as any).incomplete,true);assert.equal(r.count,0);}
  finally{cp.spawnSync=native;syncBuiltinESMExports();}
});
