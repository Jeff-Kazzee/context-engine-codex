import './testing/private-tmp.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLI, enabledFixture, hookEnv, prompt, runHook, startBounded } from './testing/hook-process.ts';
const SID = '01a10d16-4780-71c2-803c-80339e0708d7';
const notice = (stdout: string) => /revision (\d+) was validated \(sha256 ([0-9a-f]{64})\)/.exec(stdout);
const tool = (command: string, output: unknown, id: string) => ({hook_event_name:'PostToolUse',turn_id:'t1',permission_mode:'default',tool_name:'Bash',tool_input:{command},tool_response:output,tool_use_id:id});
for (const kind of ['head','other-file','failed-sha','complete-output','complete-raw','complete-stdout','read-before-edit'] as const) {
  test(`unread notice acknowledgement: ${kind}`, async t => {
    const f=enabledFixture();
    const call=async (fields:Record<string,unknown>) => {const r=await runHook(f,SID,fields);assert.equal(r.status,0,r.stderr);return r;};
    await call(prompt('ACTIVE_TASK'));
    const wc=join(f.projectRoot,'.context-engine',SID,'context.md');
    writeFileSync(wc,readFileSync(wc,'utf8')+'\n'+Array.from({length:30},(_,i)=>'retain line '+i).join('\n')+'\nEDIT_SENTINEL_AT_END\n');
    const edited=await call(tool(`sed -i 's/x/y/' .context-engine/${SID}/context.md`,'','edit'));
    const first=notice(edited.stdout);assert.ok(first);
    let command:string,argv:string[];
    if(kind==='head') {command=`head .context-engine/${SID}/context.md`;argv=['/usr/bin/head',wc];}
    else if(kind==='other-file') {const p=join(f.projectRoot,'.context-engine',SID,'notes.md');writeFileSync(p,'Unrelated note\n');command=`cat .context-engine/${SID}/notes.md`;argv=['/usr/bin/cat',p];}
    else {const hash=kind==='failed-sha'?'0'.repeat(64):first[2]!;command=`context-engine read --session ${SID} --sha ${hash}`;argv=[process.execPath,CLI,'read','--session',SID,'--sha',hash];}
    const read=await startBounded(argv,{cwd:f.projectRoot,env:hookEnv(f),input:'',timeoutMs:30000}).done;
    assert.equal(read.status,kind==='failed-sha'?1:0,read.stderr);
    if(!kind.startsWith('complete') && kind!=='read-before-edit') assert.doesNotMatch(read.stdout,/EDIT_SENTINEL_AT_END/);
    else assert.match(read.stdout,/EDIT_SENTINEL_AT_END/);
    if(kind==='read-before-edit') writeFileSync(wc,readFileSync(wc,'utf8')+'LATE_EDIT_NOT_READ\n');
    const response=kind==='complete-raw'?read.stdout:kind==='complete-stdout'?{stdout:read.stdout,exit_code:read.status}:{output:read.stdout,exit_code:read.status};
    const readHook=await call(tool(command,response,'read'));
    const later=await call(tool('ls','LATER_ORDINARY_OUTPUT','later'));
    const latest=notice(later.stdout)||notice(readHook.stdout)||first;
    const replay=await startBounded([process.execPath,CLI,'read','--session',SID,'--sha',latest[2]!],{cwd:f.projectRoot,env:hookEnv(f),input:'',timeoutMs:30000}).done;
    t.diagnostic(JSON.stringify({kind,readExit:read.status,readHookHasNotice:!!notice(readHook.stdout),laterHasNotice:!!notice(later.stdout),latestNoticeRevision:latest[1],latestNoticeReadExit:replay.status,latestNoticeReadError:replay.stderr.trim()}));
    if(kind.startsWith('complete')) assert.equal(notice(later.stdout),null,'a full successful read ends refreshing');
    else {assert.ok(notice(later.stdout),'an incomplete or failed read must not end notice refresh');assert.equal(replay.status,0,replay.stderr);}
  });
}
