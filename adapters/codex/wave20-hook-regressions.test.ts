import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { fixture } from '../../core/testing.ts';
import { setParticipation } from '../../core/index.ts';
import { layout } from '../../core/store.ts';
const HOOK=fileURLToPath(new URL('./plugin/hooks/codex-hook.ts',import.meta.url)),CLI=fileURLToPath(new URL('../../core/cli.ts',import.meta.url)),sid='WAVE20';
function setup(){const f=fixture();setParticipation({...f,state:'on'});return f;}
function hook(f:ReturnType<typeof fixture>,event:any,extra:NodeJS.ProcessEnv={}){return spawnSync(process.execPath,[HOOK],{cwd:f.projectRoot,input:JSON.stringify({cwd:f.projectRoot,session_id:sid,...event}),encoding:'utf8',env:{...process.env,CONTEXT_ENGINE_STATE_DIR:f.stateDir,CONTEXT_ENGINE_CLI:CLI,CONTEXT_ENGINE:'',...extra}});}
test('wave20: a failed prompt prevents later reset until that exact request is successfully retried',()=>{
 const f=setup();assert.equal(hook(f,{hook_event_name:'UserPromptSubmit',prompt:'ORIGINAL'}).status,0);
 const failed=hook(f,{hook_event_name:'UserPromptSubmit',prompt:'MISSING_REQUEST'},{CONTEXT_ENGINE_CLI:'missing-cli-wave20'});assert.equal(failed.status,0);
 hook(f,{hook_event_name:'PostToolUse',tool_name:'Read',tool_input:{file_path:'normal.txt'},tool_response:'RECOVERED_STORAGE'});
 assert.match(hook(f,{hook_event_name:'PreToolUse',tool_name:'new_context'}).stdout,/deny|NOT reset/);
 assert.match(hook(f,{hook_event_name:'PreCompact'}).stdout,/continue.*false/);
 const unrelated=hook(f,{hook_event_name:'UserPromptSubmit',prompt:'DIFFERENT_REQUEST'});assert.match(unrelated.stdout,/continue.*false/);
 assert.equal(hook(f,{hook_event_name:'UserPromptSubmit',prompt:'MISSING_REQUEST'}).status,0);
 assert.equal(hook(f,{hook_event_name:'PreToolUse',tool_name:'new_context'}).stdout,'');
 assert.ok(fs.readFileSync(join(f.projectRoot,'.context-engine',sid,'context.md'),'utf8').includes('MISSING_REQUEST'));
});
test('wave20: compaction marker cannot make the materialized context exceed read-back bytes',()=>{
 const f=setup();assert.equal(hook(f,{hook_event_name:'UserPromptSubmit',prompt:'ORIGINAL'}).status,0);
 const wc=join(f.projectRoot,'.context-engine',sid,'context.md'),before=fs.readFileSync(wc),preload=join(f.projectRoot,'byte-limit-fixture.mjs');
 // Exercise the real hook -> CLI append transaction at the byte boundary without allocating 16 MiB output.
 fs.writeFileSync(preload,`const original=Buffer.byteLength;Buffer.byteLength=function(value,...args){return typeof value==='string'&&value.includes('Context window reset')?16*1024*1024+1:original(value,...args)};`);
 const result=hook(f,{hook_event_name:'PreCompact',trigger:'manual'},{NODE_OPTIONS:'--import='+preload});assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,'');assert.deepEqual(fs.readFileSync(wc),before);
});

test('wave20: overlapping prompt hooks cannot clear another failed request intent',async()=>{
 const f=setup(),ready=join(f.projectRoot,'fixture-ready'),release=join(f.projectRoot,'fixture-release'),preload=join(f.projectRoot,'pause-cli.mjs');
 fs.writeFileSync(preload,`import fs from 'node:fs';if(process.argv[1]?.endsWith('/core/cli.ts')&&process.argv.includes('record')){fs.writeFileSync(${JSON.stringify(ready)},'ready');const until=Date.now()+8000;while(!fs.existsSync(${JSON.stringify(release)})){if(Date.now()>until)throw new Error('fixture release timeout');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}}`);
 function start(extra:NodeJS.ProcessEnv={}){const child=spawn(process.execPath,[HOOK],{cwd:f.projectRoot,env:{...process.env,CONTEXT_ENGINE_STATE_DIR:f.stateDir,CONTEXT_ENGINE_CLI:CLI,CONTEXT_ENGINE:'',...extra},stdio:['pipe','pipe','pipe']});let out='';child.stdout.on('data',b=>out+=b);child.stderr.resume();const done=new Promise<string>((resolve,reject)=>{child.once('error',reject);child.once('close',code=>code===0?resolve(out):reject(new Error('hook exit '+code)));});child.stdin.end(JSON.stringify({cwd:f.projectRoot,session_id:sid,hook_event_name:'UserPromptSubmit',prompt:'SAME_REQUEST'}));return {child,done};}
 const first=start({NODE_OPTIONS:'--import='+preload});let second:ReturnType<typeof start>|undefined;
 try {const until=Date.now()+6000;while(!fs.existsSync(ready)){assert.ok(Date.now()<until,'first CLI reached fixture boundary');await delay(20);}second=start({CONTEXT_ENGINE_CLI:'missing-cli-wave20'});await delay(100);fs.writeFileSync(release,'release');await first.done;assert.match(await second.done,/continue.*false/);assert.match(hook(f,{hook_event_name:'PreToolUse',tool_name:'new_context'}).stdout,/deny|NOT reset/);}
 finally {fs.writeFileSync(release,'release');first.child.kill();second?.child.kill();await first.done.catch(()=>{});await second?.done.catch(()=>{});}
});

test('wave20: a held intent lease refuses compaction before recording a marker',async()=>{
 const f=setup();assert.equal(hook(f,{hook_event_name:'UserPromptSubmit',prompt:'ORIGINAL'}).status,0);
 const ready=join(f.projectRoot,'lease-ready'),release=join(f.projectRoot,'lease-release'),holder=join(f.projectRoot,'lease-holder.mjs'),l=layout(f.projectRoot,sid,f.stateDir),log=join(l.stateDir,'events.jsonl'),before=fs.readFileSync(log);
 const module=new URL('../../core/lock.ts',import.meta.url).href;
 fs.writeFileSync(holder,`import fs from 'node:fs';import {serialized} from ${JSON.stringify(module)};serialized(${JSON.stringify(join(l.stateDir,'codex-prompt.lock'))},()=>{fs.writeFileSync(${JSON.stringify(ready)},'ready');const until=Date.now()+6000;while(!fs.existsSync(${JSON.stringify(release)})){if(Date.now()>until)throw new Error('fixture release timeout');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}});`);
 const child=spawn(process.execPath,[holder],{stdio:['ignore','ignore','pipe']});child.stderr.resume();const done=new Promise<void>((resolve,reject)=>{child.once('error',reject);child.once('close',code=>code===0?resolve():reject(new Error('holder exit '+code)));});
 try {const until=Date.now()+4000;while(!fs.existsSync(ready)){assert.ok(Date.now()<until);await delay(20);}assert.match(hook(f,{hook_event_name:'PreCompact',trigger:'manual'}).stdout,/continue.*false/);assert.deepEqual(fs.readFileSync(log),before);}
 finally {fs.writeFileSync(release,'release');await done;}
});

test('wave20: stalled compaction CLI calls finish below the hook timeout without an unreadable marker',()=>{
 const f=setup();assert.equal(hook(f,{hook_event_name:'UserPromptSubmit',prompt:'ORIGINAL'}).status,0);
 const preload=join(f.projectRoot,'stall-cli.mjs'),wc=join(f.projectRoot,'.context-engine',sid,'context.md'),before=fs.readFileSync(wc);
 fs.writeFileSync(preload,"if(process.argv[1]?.endsWith('/core/cli.ts'))await new Promise(resolve=>setTimeout(resolve,60000));");
 const start=performance.now(),result=hook(f,{hook_event_name:'PreCompact',trigger:'manual'},{NODE_OPTIONS:'--import='+preload});
 assert.equal(result.status,0);assert.ok(performance.now()-start<22000,'three stalled calls leave time under the 30s hook declaration');assert.match(result.stderr,/timed out|ETIMEDOUT/);assert.equal(result.stdout,'');assert.deepEqual(fs.readFileSync(wc),before);
});
