import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fixture,tempDir } from '../../core/testing.ts';
import { setParticipation } from '../../core/index.ts';
import { locallyEnabled } from './plugin/hooks/activation.ts';
import { spawnJsonRpc } from './turn-loop/jsonrpc.ts';

test('wave11: supported Linux HOME override matches cache-local activation',()=>{
  const f=fixture(),home=tempDir('hook-home'),stateDir=join(home,'.local/state/context-engine');setParticipation({projectRoot:f.projectRoot,stateDir,state:'on'});
  const prior={HOME:process.env.HOME,CONTEXT_ENGINE_STATE_DIR:process.env.CONTEXT_ENGINE_STATE_DIR,XDG_STATE_HOME:process.env.XDG_STATE_HOME,CONTEXT_ENGINE:process.env.CONTEXT_ENGINE};
  try {process.env.HOME=home;delete process.env.CONTEXT_ENGINE_STATE_DIR;delete process.env.XDG_STATE_HOME;delete process.env.CONTEXT_ENGINE;assert.equal(locallyEnabled(f.projectRoot),true);}
  finally {for(const [key,value]of Object.entries(prior)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
});

test('wave11: output EOF rejects pending and future RPC while child remains alive',async()=>{
  const rpc=spawnJsonRpc([process.execPath,'-e',`process.stdin.on('data',()=>{process.stdout.end();});setInterval(()=>{},1000);`],{cwd:process.cwd(),timeoutMs:1000});
  try {
    const start=Date.now();await assert.rejects(rpc.request('synthetic'),/output.*closed/);assert.ok(Date.now()-start<700);
    await assert.rejects(rpc.request('future'),/output.*closed/);assert.match((await rpc.exited).message,/output.*closed/);
    assert.doesNotThrow(()=>process.kill(rpc.pid!,0));
  }finally{await rpc.close();}
});
