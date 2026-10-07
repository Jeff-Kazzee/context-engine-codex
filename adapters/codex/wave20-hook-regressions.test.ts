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

for(const kind of ['tool','assistant'])test('wave26: failed '+kind+' record remains reset-blocking after later successful hooks',()=>{
 const f=setup();assert.equal(hook(f,{hook_event_name:'UserPromptSubmit',prompt:'BOOTSTRAP'}).status,0);
 const event=kind==='tool'?{hook_event_name:'PostToolUse',tool_name:'Read',tool_input:{file_path:'ordinary.txt'},tool_response:'COMPLETED_TOOL_EVIDENCE'}:{hook_event_name:'Stop',last_assistant_message:'COMPLETED_ASSISTANT_EVIDENCE'};
 const failed=hook(f,event,{CONTEXT_ENGINE_CLI:'missing-cli-wave26'});assert.equal(failed.status,0);
 hook(f,{hook_event_name:'PostToolUse',tool_name:'Read',tool_input:{file_path:'another.txt'},tool_response:'LATER_RECORD'});
 hook(f,{hook_event_name:'Stop',last_assistant_message:'LATER_REPLY'});
 assert.match(hook(f,{hook_event_name:'PreToolUse',tool_name:'new_context'}).stdout,/deny|NOT reset/);
 assert.match(hook(f,{hook_event_name:'PreCompact'}).stdout,/continue.*false/);
 const state=layout(f.projectRoot,sid,f.stateDir).stateDir;
 assert.ok(fs.readdirSync(state).some(name=>name.startsWith('codex-record-pending-')));
 assert.ok(!fs.readFileSync(join(state,fs.readdirSync(state).find(name=>name.startsWith('codex-record-pending-'))!),'utf8').includes('COMPLETED_'),'intent stores no tool/assistant payload');
});
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

for (const fault of ['publish', 'clear-flush']) test('wave26: completed-record intent '+fault+' failure refuses continuation', () => {
 const f=setup();hook(f,{hook_event_name:'UserPromptSubmit',prompt:'BOOTSTRAP'});
 const preload=join(f.projectRoot,'intent-fault.mjs');
 fs.writeFileSync(preload,`import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
 const unlink=fs.unlinkSync,rename=fs.renameSync,flush=fs.fsyncSync;let clearing=false;
 fs.renameSync=function(a,b){if(${JSON.stringify(fault)}==='publish'&&/codex-record-pending-[0-9a-f-]+\\.json$/.test(String(b)))throw new Error('synthetic intent publication failure');return rename(a,b);};
 fs.unlinkSync=function(path){const out=unlink(path);if(/codex-record-pending-[0-9a-f-]+\\.json$/.test(String(path)))clearing=true;return out;};
 fs.fsyncSync=function(fd){if(clearing){clearing=false;throw new Error('synthetic clear flush failure');}return flush(fd);};syncBuiltinESMExports();`);
 const result=hook(f,{hook_event_name:'Stop',last_assistant_message:'COMPLETED_EVENT'},{NODE_OPTIONS:'--import='+preload});
 assert.match(result.stdout,/continue.*false/);
 if(fault==='clear-flush'){
  const state=layout(f.projectRoot,sid,f.stateDir).stateDir;assert.ok(fs.readdirSync(state).some(name=>name.startsWith('codex-record-pending-')));
  assert.match(hook(f,{hook_event_name:'UserPromptSubmit',prompt:'LATER'}).stdout,/continue.*false/);
 }
});
test('wave26: successfully recorded completed events clear only their own intent',()=>{
 const f=setup();hook(f,{hook_event_name:'UserPromptSubmit',prompt:'BOOTSTRAP'});
 hook(f,{hook_event_name:'PostToolUse',tool_name:'Read',tool_input:{file_path:'ordinary.txt'},tool_response:'RECORDED_TOOL'});
 hook(f,{hook_event_name:'Stop',last_assistant_message:'RECORDED_REPLY'});
 assert.equal(fs.readdirSync(layout(f.projectRoot,sid,f.stateDir).stateDir).some(name=>name.startsWith('codex-record-pending-')),false);
 assert.equal(hook(f,{hook_event_name:'PreToolUse',tool_name:'new_context'}).stdout,'');
});

test('wave26: a completed hook lease timeout retains independent intent after the first succeeds',async()=>{
 const f=setup();hook(f,{hook_event_name:'UserPromptSubmit',prompt:'BOOTSTRAP'});
 const pause=join(f.projectRoot,'pause.mjs'),ready=join(f.projectRoot,'first-record-ready');
 fs.writeFileSync(pause,`import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const original=fs.writeSync;let paused=false;fs.writeSync=function(fd,data,...args){if(!paused&&String(data).includes('FIRST_COMPLETED')){paused=true;fs.writeFileSync(${JSON.stringify(ready)},'ready');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,13000);}return original(fd,data,...args)};syncBuiltinESMExports();`);
 const first=spawn(process.execPath,[HOOK],{cwd:f.projectRoot,env:{...process.env,CONTEXT_ENGINE_STATE_DIR:f.stateDir,CONTEXT_ENGINE_CLI:CLI,NODE_OPTIONS:'--import='+pause},stdio:['pipe','pipe','pipe']});
 let firstOutput='';first.stdout.on('data',chunk=>firstOutput+=chunk);first.stderr.resume();const ended=new Promise<void>((resolve,reject)=>{first.on('error',reject);first.on('exit',()=>resolve());});
 first.stdin.end(JSON.stringify({cwd:f.projectRoot,session_id:sid,hook_event_name:'Stop',last_assistant_message:'FIRST_COMPLETED'}));
 try{for(let i=0;i<200&&!fs.existsSync(ready);i++)await delay(10);assert.ok(fs.existsSync(ready));
  assert.match(hook(f,{hook_event_name:'Stop',last_assistant_message:'SECOND_COMPLETED'}).stdout,/continue.*false/);
  await ended;assert.equal(firstOutput,'','first completed event recorded successfully');assert.match(fs.readFileSync(join(f.projectRoot,'.context-engine',sid,'context.md'),'utf8'),/FIRST_COMPLETED/);assert.match(hook(f,{hook_event_name:'PreToolUse',tool_name:'new_context'}).stdout,/deny/);
  assert.match(hook(f,{hook_event_name:'PreCompact'}).stdout,/continue.*false/);
 }finally{first.kill();await ended;}
});

test('wave26: concurrent healthy completed hooks record and clear only their own intents',async()=>{
 const f=setup();hook(f,{hook_event_name:'UserPromptSubmit',prompt:'BOOTSTRAP'});
 const pause=join(f.projectRoot,'publish-pause.mjs');fs.writeFileSync(pause,`import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const rename=fs.renameSync;fs.renameSync=function(a,b){const r=rename(a,b);if(/codex-record-pending-/.test(String(b)))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,800);return r;};syncBuiltinESMExports();`);
 const children=['CONCURRENT_A','CONCURRENT_B'].map(text=>{
  const child=spawn(process.execPath,[HOOK],{cwd:f.projectRoot,env:{...process.env,CONTEXT_ENGINE_STATE_DIR:f.stateDir,CONTEXT_ENGINE_CLI:CLI,NODE_OPTIONS:'--import='+pause},stdio:['pipe','pipe','pipe']});
  child.stdout.resume();child.stderr.resume();const done=new Promise<void>((resolve,reject)=>{child.on('error',reject);child.on('exit',()=>resolve());});
  child.stdin.end(JSON.stringify({cwd:f.projectRoot,session_id:sid,hook_event_name:'Stop',last_assistant_message:text}));return {child,done};
 });
 try{await Promise.all(children.map(c=>c.done));const state=layout(f.projectRoot,sid,f.stateDir).stateDir;
  assert.equal(fs.readdirSync(state).some(n=>n.startsWith('codex-record-pending-')),false);
  const wc=fs.readFileSync(join(f.projectRoot,'.context-engine',sid,'context.md'),'utf8');assert.match(wc,/CONCURRENT_A/);assert.match(wc,/CONCURRENT_B/);
  assert.equal(hook(f,{hook_event_name:'PreToolUse',tool_name:'new_context'}).stdout,'');
 }finally{for(const c of children)c.child.kill();await Promise.all(children.map(c=>c.done));}
});

for(const kind of ['prompt','reset','compact'])test('wave26: '+kind+' gate rechecks completed intent published during core work',async()=>{
 const f=setup();hook(f,{hook_event_name:'UserPromptSubmit',prompt:'BOOTSTRAP'});
 const pause=join(f.projectRoot,'gate-pause.mjs'),ready=join(f.projectRoot,'gate-ready');
 fs.writeFileSync(pause,`import cp from 'node:child_process';import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const spawn=cp.spawnSync;let paused=false;cp.spawnSync=function(cmd,args,...rest){if(!paused){paused=true;fs.writeFileSync(${JSON.stringify(ready)},'ready');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1800);}return spawn(cmd,args,...rest);};syncBuiltinESMExports();`);
 const event=kind==='prompt'?{hook_event_name:'UserPromptSubmit',prompt:'GATED_PROMPT'}:kind==='reset'?{hook_event_name:'PreToolUse',tool_name:'new_context'}:{hook_event_name:'PreCompact',trigger:'manual'};
 const gate=spawn(process.execPath,[HOOK],{cwd:f.projectRoot,env:{...process.env,CONTEXT_ENGINE_STATE_DIR:f.stateDir,CONTEXT_ENGINE_CLI:CLI,NODE_OPTIONS:'--import='+pause},stdio:['pipe','pipe','pipe']});let out='';gate.stdout.on('data',chunk=>out+=chunk);gate.stderr.resume();const ended=new Promise<void>((resolve,reject)=>{gate.on('error',reject);gate.on('exit',()=>resolve());});
 gate.stdin.end(JSON.stringify({cwd:f.projectRoot,session_id:sid,...event}));
 try{for(let i=0;i<200&&!fs.existsSync(ready);i++)await delay(10);assert.ok(fs.existsSync(ready));
  hook(f,{hook_event_name:'Stop',last_assistant_message:'COMPLETED_DURING_GATE'});await ended;assert.match(out,kind==='reset'?/deny/:/continue.*false/);
 }finally{gate.kill();await ended;}
});

test('wave26: shell sync and record calls share a bounded host-time allowance',()=>{
 const f=setup();hook(f,{hook_event_name:'UserPromptSubmit',prompt:'BOOTSTRAP'});
 const preload=join(f.projectRoot,'two-call-delay.mjs'),calls=join(f.projectRoot,'call-bounds.jsonl');
 fs.writeFileSync(preload,`import cp from 'node:child_process';import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const native=cp.spawnSync;cp.spawnSync=function(cmd,args,opts){const operation=args.find(x=>x==='sync'||x==='record');fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({operation,timeout:opts.timeout})+'\\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);if(operation==='record')return {status:null,stdout:'',stderr:'',error:Object.assign(new Error('synthetic delayed record timeout'),{code:'ETIMEDOUT'})};return native(cmd,args,opts);};syncBuiltinESMExports();`);
 const result=hook(f,{hook_event_name:'PostToolUse',tool_name:'Bash',tool_input:{command:'ordinary-check'},tool_response:'COMPLETED_SHELL'},{NODE_OPTIONS:'--import='+preload});
 assert.match(result.stdout,/continue.*false/);
 const observed=fs.readFileSync(calls,'utf8').trim().split('\n').map(line=>JSON.parse(line));assert.deepEqual(observed,[{operation:'sync',timeout:7500},{operation:'record',timeout:7500}]);
 assert.ok(10000+observed.reduce((sum,c)=>sum+c.timeout,0)<30000);
 assert.match(hook(f,{hook_event_name:'PreToolUse',tool_name:'new_context'}).stdout,/deny/);
});
