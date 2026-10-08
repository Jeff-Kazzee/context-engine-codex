import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {fixture} from '../../core/testing.ts';
import {setParticipation} from '../../core/index.ts';
import {layout,sha} from '../../core/store.ts';
const hook=fileURLToPath(new URL('./plugin/hooks/codex-hook.ts',import.meta.url));
const cli=fileURLToPath(new URL('../../core/cli.ts',import.meta.url));
const sid='W31-HOOK';

for(const fault of ['marker-write','process-death']) test('wave31: exact prompt retry after '+fault+' records once',()=>{
  const f=fixture();setParticipation({...f,state:'on'});
  const preload=join(f.projectRoot,'after-record.mjs');
  fs.writeFileSync(preload,fault==='marker-write'
    ? `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const write=fs.writeSync;fs.writeSync=function(fd,data,...args){if(String(data).includes('"recorded":true'))throw new Error('SYNTHETIC_MARKER_FAILURE');return write(fd,data,...args);};syncBuiltinESMExports();`
    : `import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';const spawn=cp.spawnSync;cp.spawnSync=function(cmd,args,...rest){const result=spawn(cmd,args,...rest);if(args.includes('record')&&result.status===0)process.kill(process.pid,'SIGKILL');return result;};syncBuiltinESMExports();`);
  const input=JSON.stringify({cwd:f.projectRoot,session_id:sid,hook_event_name:'UserPromptSubmit',prompt:'W31_ONE_REQUEST'});
  const opts={cwd:f.projectRoot,input,encoding:'utf8' as const,timeout:30000,env:{...process.env,CONTEXT_ENGINE_STATE_DIR:f.stateDir,CONTEXT_ENGINE_CLI:cli,CONTEXT_ENGINE:''}};
  const first=spawnSync(process.execPath,[hook],{...opts,env:{...opts.env,NODE_OPTIONS:'--import='+preload}});
  if(fault==='marker-write')assert.match(first.stdout,/continue.*false/);else assert.equal(first.signal,'SIGKILL');
  const retry=spawnSync(process.execPath,[hook],opts);assert.equal(retry.status,0,retry.stderr);assert.doesNotMatch(retry.stdout,/continue.*false/);
  const state=layout(f.projectRoot,sid,f.stateDir).stateDir;
  const count=()=>fs.readFileSync(join(state,'events.jsonl'),'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line)).filter(row=>row.type==='runner-events'&&JSON.stringify(row).includes('W31_ONE_REQUEST')).length;
  assert.equal(count(),1);assert.equal(fs.readFileSync(join(f.projectRoot,'.context-engine',sid,'context.md'),'utf8').match(/W31_ONE_REQUEST/g)?.length,1);
  const fresh=spawnSync(process.execPath,[hook],opts);assert.equal(fresh.status,0,fresh.stderr);assert.doesNotMatch(fresh.stdout,/continue.*false/);assert.equal(count(),2);
});

test('wave31: legacy ambiguous prompt intent refuses without changing context',()=>{
  const f=fixture();setParticipation({...f,state:'on'});
  const input=JSON.stringify({cwd:f.projectRoot,session_id:sid,hook_event_name:'UserPromptSubmit',prompt:'LEGACY_REQUEST'});
  const opts={cwd:f.projectRoot,input,encoding:'utf8' as const,env:{...process.env,CONTEXT_ENGINE_STATE_DIR:f.stateDir,CONTEXT_ENGINE_CLI:cli,CONTEXT_ENGINE:''}};
  assert.equal(spawnSync(process.execPath,[hook],opts).status,0);
  const state=layout(f.projectRoot,sid,f.stateDir).stateDir,wc=join(f.projectRoot,'.context-engine',sid,'context.md');
  const before=fs.readFileSync(wc);fs.writeFileSync(join(state,'codex-prompt-pending.json'),JSON.stringify({hash:sha('LEGACY_REQUEST')}));
  const result=spawnSync(process.execPath,[hook],opts);assert.match(result.stdout,/continue.*false/);assert.match(result.stderr,/operation identifier/);assert.deepEqual(fs.readFileSync(wc),before);
});
