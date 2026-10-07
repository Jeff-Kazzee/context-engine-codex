import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fixture, tempDir } from '../../../core/testing.ts';
import { inspectSession } from '../../../core/index.ts';
import { guidance, MODE, OWN_OVERRIDES, startTurnLoop as start, type CodexTurnLoop, type TurnLoopOptions } from './turn-loop.ts';
import { validateInjectItems } from './items.ts';
import { FAKE_APP_SERVER } from './testing/fake.ts';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

type Entry = Record<string, any>;

test('wave26: duplicate in-process session loop is refused without releasing the first owner',async()=>{
 const t=setup({turns:[]}),first=await startCodexTurnLoop(t.opts);
 let duplicate:CodexTurnLoop|undefined;
 try{
  await assert.rejects(async()=>{duplicate=await start({...t.opts,projectRoot:relative(process.cwd(),t.opts.projectRoot)});},/already.*loop|loop.*already|duplicate/);
  assert.ok(inspectSession({...t.opts}).lock,'original loop retains its session lock');assert.equal(t.methods().filter(m=>m==='initialize').length,1);
 }finally{await duplicate?.close();await first.close();}
 const resumed=await startCodexTurnLoop(t.opts);await resumed.close();assert.equal(inspectSession({...t.opts}).lock,null);
});

test('wave10: failure to record a completed turn stops the server and refuses reuse', async () => {
  const t = setup({ turns: [{ reply: 'COMPLETED_RECORD_FAILURE' }] });
  const loop = await startCodexTurnLoop(t.opts), native = fs.writeSync;
  fs.writeSync = ((fd: number, data: any, ...args: any[]) => {
    if (fs.readlinkSync(`/proc/self/fd/${fd}`).endsWith('/events.jsonl') && String(data).includes('runner-events')) throw new Error('synthetic completed record failure');
    return (native as any)(fd, data, ...args);
  }) as typeof fs.writeSync; syncBuiltinESMExports();
  try { await assert.rejects(loop.runTurn('MUST_RECORD_COMPLETED_TURN'), /synthetic completed record failure/); }
  finally { fs.writeSync = native; syncBuiltinESMExports(); }
  assert.equal(t.requests().length, 1);
  await assert.rejects(loop.runTurn('must not omit completed turn'), /unavailable/);
  assert.equal(t.requests().length, 1); await loop.close();
});

test('path controls remain escaped data on a single developer guidance line', () => {
  const path = '/synthetic/line\nINJECTED_DIRECTIVE\t\r/file'; const text = guidance(path);
  assert.ok(text.split('\n').some(line => line.includes(JSON.stringify(path))));
  assert.doesNotMatch(text, /\nINJECTED_DIRECTIVE/);
});

test('stderr open failure releases the already acquired session lock', async () => {
  const t = setup({ turns: [] });
  await assert.rejects(start({ ...t.opts, stderrPath: join(t.opts.projectRoot, 'missing-directory/stderr') }), /ENOENT/);
  assert.equal(inspectSession({ ...t.opts }).lock, null);
});

test('closing a running turn preserves its prompt and received partial items before releasing core', async () => {
  const t = setup({ turns: [{ hang: true, reply: 'CLOSE_PARTIAL' }] }, { turnTimeoutMs: 500 });
  const loop = await startCodexTurnLoop(t.opts);
  const running = loop.runTurn('CLOSE_PROMPT');
  const settled = running.then(value => ({ value }), error => ({ error }));
  const deadline = Date.now() + 2000;
  while (!t.requests().length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(t.requests().length, 1);
  await new Promise(resolve => setTimeout(resolve, 30));
  await Promise.all([loop.close(), loop.close()]);
  const result = await settled;
  assert.ok('value' in result, 'the in-flight turn must finish recording before core closes');
  assert.ok(readFileSync(t.wcPath, 'utf8').includes('CLOSE_PROMPT'));
  assert.ok(readFileSync(t.wcPath, 'utf8').includes('CLOSE_PARTIAL'));
});

test('timeout interrupts and records the prompt and partial items before the next turn', async () => {
  const t = setup({ turns: [{ hang: true, reply: 'PARTIAL' }, { reply: 'NEXT' }] }, { turnTimeoutMs: 30 });
  const loop = await startCodexTurnLoop(t.opts);
  const r = await loop.runTurn('TIMEOUT_PROMPT');
  assert.equal(r.status, 'interrupted');
  assert.equal(r.finalMessage, 'PARTIAL');
  assert.deepEqual(t.sent('turn/interrupt'), [{ threadId: r.threadId, turnId: r.turnId }]);
  const next = await loop.runTurn('next');
  assert.equal(next.status, 'completed');
  assert.match(t.requests()[1]!.input[0]!.text, /TIMEOUT_PROMPT[\s\S]*PARTIAL/);
  const events = readFileSync(join(t.f.stateDir, (await import('../../../core/store.ts')).projectKey(t.f.projectRoot), 'S1', 'events.jsonl'), 'utf8');
  assert.match(events, /TIMEOUT_PROMPT/); assert.match(events, /PARTIAL/);
});

test('turn start failure records the prompt and prevents an uncertain orphan from racing another turn', async () => {
  const t = setup({ errors: { 'turn/start': { code: -32600, message: 'start rejected' } } });
  const loop = await startCodexTurnLoop(t.opts);
  const r = await loop.runTurn('REJECTED_PROMPT');
  assert.equal(r.status, 'failed');
  assert.match(String(r.error), /start rejected/);
  assert.match(readFileSync(t.wcPath, 'utf8'), /REJECTED_PROMPT/);
  await assert.rejects(loop.runTurn('must not race'), /unavailable/);
});

test('an unacknowledged interruption shuts down the owned server and refuses reuse', async () => {
  const t = setup({ turns: [{ hang: true, ignoreInterrupt: true, reply: 'PARTIAL' }] }, { turnTimeoutMs: 30 });
  const loop = await startCodexTurnLoop(t.opts);
  const r = await loop.runTurn('unsafe to continue');
  assert.equal(r.status, 'failed');
  assert.match(readFileSync(t.wcPath, 'utf8'), /unsafe to continue[\s\S]*PARTIAL/);
  await assert.rejects(loop.runTurn('next'), /unavailable/);
});

// Every turn loop a test starts is closed afterwards, even when an assertion fails mid-test.
const open: CodexTurnLoop[] = [];
afterEach(async () => {
  for (const d of open.splice(0)) await d.close();
});
async function startCodexTurnLoop(opts: TurnLoopOptions): Promise<CodexTurnLoop> {
  const d = await start(opts);
  open.push(d);
  return d;
}

function setup(script: object, extra: Partial<TurnLoopOptions> = {}) {
  const f = fixture();
  const dir = tempDir('fake-codex');
  const logPath = join(dir, 'log.jsonl');
  const scriptPath = join(dir, 'script.json');
  writeFileSync(scriptPath, JSON.stringify(script));
  const opts: TurnLoopOptions = {
    projectRoot: f.projectRoot,
    sessionId: 'S1',
    stateDir: f.stateDir,
    model: 'fake-model',
    command: [process.execPath, FAKE_APP_SERVER],
    env: { ...process.env, FAKE_CODEX_LOG: logPath, FAKE_CODEX_SCRIPT: scriptPath },
    ...extra,
  };
  const log = (): Entry[] =>
    existsSync(logPath)
      ? readFileSync(logPath, 'utf8')
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l) as Entry)
      : [];
  const methods = () => log().flatMap((e) => (e.recv?.method ? [e.recv.method as string] : []));
  const requests = () => log().flatMap((e) => (e.modelRequest ? [e.modelRequest as { threadId: string; input: Array<{ role: string; text: string }> }] : []));
  const sent = (method: string) => log().flatMap((e) => (e.recv?.method === method ? [e.recv.params] : []));
  const wcPath = join(f.projectRoot, '.context-engine', 'S1', 'context.md');
  return { f, opts, log, methods, requests, sent, wcPath, setScript: (s: object) => writeFileSync(scriptPath, JSON.stringify(s)) };
}

test('three turns: each later turn starts from initial context + the Working Context as one user message + the new prompt', async () => {
  const t = setup({ turns: [{ reply: 'ANSWER_ONE' }, { reply: 'ANSWER_TWO' }, { reply: 'ANSWER_THREE' }] });
  const loop = await startCodexTurnLoop(t.opts);
  assert.equal(loop.mode, 'Full Replacement per user turn');
  assert.equal(MODE, loop.mode);
  const r1 = await loop.runTurn('PROMPT_ONE');
  const r2 = await loop.runTurn('PROMPT_TWO');
  const r3 = await loop.runTurn('PROMPT_THREE');
  await loop.close();

  assert.deepEqual(
    [r1, r2, r3].map((r) => [r.status, r.replaced, r.finalMessage, r.mode]),
    [
      ['completed', false, 'ANSWER_ONE', MODE],
      ['completed', true, 'ANSWER_TWO', MODE],
      ['completed', true, 'ANSWER_THREE', MODE],
    ],
  );

  // Its own app-server over stdio, never a daemon socket, with the plugin path switched off.
  assert.deepEqual(t.log()[0]!.argv, ['app-server', '--listen', 'stdio://', '-c', 'features.token_budget=false', '-c', 'plugins.context-engine@context-engine.enabled=false']);

  const [q1, q2, q3] = t.requests();
  assert.deepEqual(q1!.input, [{ role: 'user', text: 'PROMPT_ONE' }]);
  for (const [q, prompt] of [[q2!, 'PROMPT_TWO'], [q3!, 'PROMPT_THREE']] as const) {
    assert.equal(q.input.length, 2, 'only the Working Context and the new prompt');
    assert.equal(q.input[0]!.role, 'user');
    assert.match(q.input[0]!.text, /^<working_context path="[^"]+context\.md">\n\[\[CTX_TURN 1 role=user\]\]\nPROMPT_ONE\n/);
    assert.deepEqual(q.input[1], { role: 'user', text: prompt });
  }
  assert.match(q2!.input[0]!.text, /ANSWER_ONE/);
  assert.doesNotMatch(q2!.input[0]!.text, /PROMPT_TWO/);
  assert.match(q3!.input[0]!.text, /ANSWER_ONE[\s\S]*PROMPT_TWO[\s\S]*ANSWER_TWO/);
  assert.equal(new Set([q1!.threadId, q2!.threadId, q3!.threadId]).size, 3, 'replaced turns are absent: every turn starts on a fresh thread');

  assert.deepEqual(t.methods(), [
    'initialize',
    'initialized',
    'thread/start',
    'turn/start',
    'thread/start',
    'thread/inject_items',
    'thread/unsubscribe',
    'turn/start',
    'thread/start',
    'thread/inject_items',
    'thread/unsubscribe',
    'turn/start',
  ]);
  for (const p of t.sent('thread/inject_items')) assert.deepEqual(validateInjectItems(p.items), []);
  for (const p of t.sent('thread/start')) {
    assert.equal(p.ephemeral, true);
    assert.equal(p.cwd, t.f.projectRoot);
    assert.equal(p.model, 'fake-model');
    assert.match(p.developerInstructions, /context\.md/);
    assert.doesNotMatch(p.developerInstructions, /<working_context/, 'the carrier tag only ever appears in the injected user message');
  }
  assert.match(readFileSync(t.wcPath, 'utf8'), /ANSWER_THREE/);
});

test('a model edit during a turn is what the next turn sees, with the commit receipt', async () => {
  const t = setup({});
  const edited = '[[CTX_TURN 1 role=user]]\nTask: KEEP_ME\n\n[[CTX_TURN 2 role=assistant]]\nnote: ADDED_BY_MODEL\n';
  t.setScript({ turns: [{ reply: 'STALE_REPLY' }, { writeFile: { path: t.wcPath, content: edited }, reply: 'ok' }, { reply: 'done' }] });
  const loop = await startCodexTurnLoop(t.opts);
  await loop.runTurn('first: DELETE_ME_LATER');
  const r2 = await loop.runTurn('second');
  const r3 = await loop.runTurn('third');
  await loop.close();

  assert.deepEqual(r2.receipts, []);
  assert.equal(r3.receipts.length, 1);
  assert.equal(r3.receipts[0]!.kind, 'committed');
  const q3 = t.requests()[2]!;
  const wc = q3.input[0]!.text;
  assert.match(wc, /KEEP_ME[\s\S]*ADDED_BY_MODEL/);
  assert.doesNotMatch(wc, /DELETE_ME_LATER|STALE_REPLY/, 'what the model deleted is gone');
  assert.match(wc, /second[\s\S]*ok/, 'the runner appends the turn after the edit');
  assert.equal(q3.input.length, 2);
  assert.equal(q3.input[1]!.text, `${r3.receipts[0]!.text}\nthird`, 'the receipt rides with the prompt, not in the Working Context message');
});

test('a Working Context that fails validation refuses the turn: no model call, no continuation of the old thread, a receipt says why', async () => {
  const t = setup({});
  t.setScript({ turns: [{}, { writeFile: { path: t.wcPath, content: 'task\u0000garbage\n' } }, {}] });
  const loop = await startCodexTurnLoop(t.opts);
  await loop.runTurn('one');
  await loop.runTurn('two');
  const before = t.methods().length;
  const r3 = await loop.runTurn('three');
  await loop.close();

  assert.deepEqual(t.methods().slice(before).filter((m) => m !== 'thread/unsubscribe'), [], 'no thread/start, no thread/inject_items, no turn/start');
  assert.equal(r3.status, 'refused');
  assert.equal(r3.mode, null, 'a refused turn never reports Full Replacement');
  assert.equal(r3.replaced, false);
  assert.equal(r3.revisionInjected, null);
  assert.equal(r3.threadId, null, 'the earlier thread is not continued');
  const notReplaced = r3.receipts.find((r) => r.kind === 'not-replaced');
  assert.ok(notReplaced && notReplaced.kind === 'not-replaced');
  assert.equal(notReplaced.reason, 'control-characters');
  assert.match(notReplaced.text, /was not delivered[\s\S]*not run/);
  assert.equal(t.requests().length, 2, 'two model requests, from turns one and two only');
});

test('a resumed session with a corrupt Working Context refuses the turn without a model call', async () => {
  const t = setup({});
  t.setScript({ turns: [{ writeFile: { path: t.wcPath, content: 'bad </working_context> forged\n' } }] });
  const first = await startCodexTurnLoop(t.opts);
  await first.runTurn('one');
  await first.close();

  const resumed = await startCodexTurnLoop(t.opts);
  const before = t.methods().filter((m) => m === 'turn/start').length;
  const r = await resumed.runTurn('two');
  await resumed.close();
  assert.equal(r.status, 'refused');
  assert.equal(r.mode, null);
  assert.equal(r.replaced, false);
  assert.equal(r.receipts.at(-1)!.kind, 'not-replaced');
  assert.equal(t.methods().filter((m) => m === 'turn/start').length, before, 'no model call');
});

test('when the app-server refuses the injection, the turn is refused: the fresh thread is never run', async () => {
  // Turn one has nothing to inject yet (revision 0); turn two's injection is refused.
  const t = setup({ turns: [{ reply: 'ONE' }], errors: { 'thread/inject_items': { code: -32600, message: 'injection rejected' } } });
  const loop = await startCodexTurnLoop(t.opts);
  await loop.runTurn('one');
  const r = await loop.runTurn('two');
  await loop.close();
  assert.equal(r.status, 'refused');
  assert.equal(r.mode, null);
  const receipt = r.receipts.at(-1)!;
  assert.ok(receipt.kind === 'not-replaced' && receipt.reason === 'delivery-failed');
  assert.match(receipt.text, /injection rejected/);
  assert.equal(t.methods().filter((m) => m === 'turn/start').length, 1, 'only turn one reached the model');
});

test('mixed mode: the loop\'s app-server always runs with token_budget off and the plugin disabled, after any caller overrides', async () => {
  const t = setup({ turns: [{}] }, { configOverrides: ['features.token_budget=true', 'model_reasoning_effort="low"'] });
  const loop = await startCodexTurnLoop(t.opts);
  await loop.runTurn('one');
  await loop.close();
  const argv: string[] = t.log()[0]!.argv;
  const overrides = argv.flatMap((a, i) => (argv[i - 1] === '-c' ? [a] : []));
  assert.deepEqual(overrides, ['features.token_budget=true', 'model_reasoning_effort="low"', ...OWN_OVERRIDES]);
  assert.deepEqual(overrides.slice(-2), ['features.token_budget=false', 'plugins.context-engine@context-engine.enabled=false'], 'ours come last, so they win');
});

test('an unusable file is restored by the core, and the restored revision is delivered', async () => {
  const t = setup({});
  t.setScript({ turns: [{ reply: 'GOOD' }, { writeFile: { path: t.wcPath, contentBase64: Buffer.from([0xff, 0xfe, 0x00]).toString('base64') } }, {}] });
  const loop = await startCodexTurnLoop(t.opts);
  await loop.runTurn('one');
  await loop.runTurn('two');
  const r3 = await loop.runTurn('three');
  await loop.close();
  assert.equal(r3.replaced, true);
  assert.equal(r3.receipts[0]!.kind, 'restored');
  assert.match(t.requests()[2]!.input[0]!.text, /GOOD/);
});

test('the kill switch CONTEXT_ENGINE=off stops the turn loop before it opens a session or spawns Codex', async () => {
  const t = setup({ turns: [] });
  await assert.rejects(start({ ...t.opts, env: { ...t.opts.env, CONTEXT_ENGINE: 'off' } }), /turned off.*CONTEXT_ENGINE=off/);
  assert.equal(existsSync(t.f.stateDir), false, 'no session state');
  assert.deepEqual(t.log(), [], 'no app-server spawned');
});

test('actual turn loop uses the validated revision when its workspace path is replaced after sync', async () => {
  const { stripTypeScriptTypes } = await import('node:module');
  const coreModule = await import('../../../core/index.ts');
  const fsModule = await import('node:fs');
  const pathModule = await import('node:path');
  const itemsModule = await import('./items.ts');
  const rpcModule = await import('./jsonrpc.ts');
  const source = readFileSync(new URL('./turn-loop.ts', import.meta.url), 'utf8');
  const erased = stripTypeScriptTypes(source).replace(/^import[\s\S]*?from ['"][^'"]+['"];\s*/gm, '').replace(/^export (?=(?:const|async function|function|class))/gm, '');
  let replace = false;
  const t = setup({ turns: [{ reply: 'first reply' }, { reply: 'second reply' }] });
  const privatePath = join(t.f.projectRoot, 'synthetic-private-target'); writeFileSync(privatePath, 'MUST_NOT_INJECT_SYNTHETIC');
  const openSession = (opts: any) => {
    const opened = coreModule.openSession(opts);
    if (opened.status !== 'open') return opened;
    const session = new Proxy(opened.session, { get(target, key) {
      if (key === 'sync') return () => { const result = target.sync(); if (replace) { replace = false; rmSync(t.wcPath); symlinkSync(privatePath, t.wcPath); } return result; };
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
    return { ...opened, session };
  };
  const load = new Function('coreModule', 'fsModule', 'pathModule', 'itemsModule', 'rpcModule', 'openSession', `const {${Object.keys(coreModule).filter(k => k !== 'openSession').join(',')}} = coreModule; const {closeSync,openSync,realpathSync} = fsModule; const {basename,dirname,join,resolve} = pathModule; const {workingContextItems} = itemsModule; const {spawnJsonRpc} = rpcModule; ${erased}; return startTurnLoop;`);
  const actualStart = load(coreModule, fsModule, pathModule, itemsModule, rpcModule, openSession);
  const loop = await actualStart(t.opts); open.push(loop);
  await loop.runTurn('VALIDATED_SENTINEL'); replace = true;
  const result = await loop.runTurn('next request'); assert.equal(result.status, 'completed');
  const injected = t.sent('thread/inject_items');
  assert.match(JSON.stringify(injected), /VALIDATED_SENTINEL/); assert.doesNotMatch(JSON.stringify(injected), /MUST_NOT_INJECT_SYNTHETIC/);
});

test('relative project root is canonical for both app-server cwd and thread cwd', async () => {
  const t=setup({turns:[{reply:'SYNTHETIC_REPLY'}]});
  const loop=await startCodexTurnLoop({...t.opts,projectRoot:relative(process.cwd(),t.f.projectRoot)});
  await loop.runTurn('SYNTHETIC_PROMPT');
  assert.equal(t.sent('thread/start')[0].cwd,t.f.projectRoot);
});

test('renewed: refused injection unsubscribes the newly allocated thread',async()=>{
 const t=setup({turns:[{reply:'BASE'}],errors:{'thread/inject_items':{code:-32600,message:'synthetic refusal'}}});
 const loop=await startCodexTurnLoop(t.opts);await loop.runTurn('baseline');
 const result=await loop.runTurn('refuse');assert.equal(result.status,'refused');
 assert.deepEqual(t.sent('thread/unsubscribe'),[{threadId:t.sent('thread/start').length===2?'thread-2':'unexpected'}]);
});

test('wave26: uncertain server shutdown retains cross-process and in-process ownership', async()=>{
 const {stripTypeScriptTypes}=await import('node:module');
 const coreModule=await import('../../../core/index.ts'),fsModule=await import('node:fs'),pathModule=await import('node:path'),itemsModule=await import('./items.ts');
 const source=readFileSync(new URL('./turn-loop.ts',import.meta.url),'utf8');
 const erased=stripTypeScriptTypes(source).replace(/^import[\s\S]*?from ['"][^'"]+['"];\s*/gm,'').replace(/^export (?=(?:const|async function|function|class))/gm,'');
 const t=setup({turns:[]});let owned: any;
 const openSession=(opts:any)=>{const r=coreModule.openSession(opts);if(r.status==='open')owned=r.session;return r;};
 const rpcModule={spawnJsonRpc:()=>({request:async()=>({}),notify:()=>{},close:async()=>{throw new Error('synthetic uncertain shutdown');}})};
 const load=new Function('coreModule','fsModule','pathModule','itemsModule','rpcModule','openSession',`const {${Object.keys(coreModule).filter(k=>k!=='openSession').join(',')}}=coreModule;const {closeSync,openSync,realpathSync}=fsModule;const {basename,dirname,join,resolve}=pathModule;const {workingContextItems}=itemsModule;const {spawnJsonRpc}=rpcModule;${erased};return startTurnLoop;`);
 const actual=load(coreModule,fsModule,pathModule,itemsModule,rpcModule,openSession),loop=await actual(t.opts);
 try{
  await assert.rejects(loop.close(),/uncertain shutdown/);
  assert.ok(inspectSession(t.opts).lock);
  assert.equal(coreModule.openSession({...t.opts,runner:'codex',hardLimit:400000,ownerPid:2147483646}).status,'refused');
  await assert.rejects(actual(t.opts),/already.*loop/);
 }finally{owned.close();}
});


test('wave31: confirmed shutdown releases registry after receipt acknowledgement fails', async()=>{
  const {stripTypeScriptTypes}=await import('node:module');
  const coreModule=await import('../../../core/index.ts'),fsModule=await import('node:fs'),pathModule=await import('node:path'),itemsModule=await import('./items.ts');
  const {appendLog}=await import('../../../core/store.ts');
  const t=setup({turns:[]}), seed=coreModule.openSession({...t.opts,runner:'codex',hardLimit:400000});assert.equal(seed.status,'open');
  seed.session.record([{role:'user',text:'RECOVERY_FOR_CLOSE'}]);const log=join(seed.session.stateDir,'events.jsonl');seed.session.close();
  const row=readFileSync(log,'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line)).find(row=>row.type==='revision');appendLog(log,{...row,recovered:true});
  const source=readFileSync(new URL('./turn-loop.ts',import.meta.url),'utf8');
  const erased=stripTypeScriptTypes(source).replace(/^import[\s\S]*?from ['"][^'"]+['"];\s*/gm,'').replace(/^export (?=(?:const|async function|function|class))/gm,'');
  let shutdowns=0;
  const openSession=(opts:any)=>{const r=coreModule.openSession(opts);if(r.status==='open')r.session.sync();return r;};
  const rpcModule={spawnJsonRpc:()=>({request:async()=>({}),notify:()=>{},close:async()=>{shutdowns++;}})};
  const load=new Function('coreModule','fsModule','pathModule','itemsModule','rpcModule','openSession',`const {${Object.keys(coreModule).filter(k=>k!=='openSession').join(',')}}=coreModule;const {closeSync,openSync,realpathSync}=fsModule;const {basename,dirname,join,resolve}=pathModule;const {workingContextItems}=itemsModule;const {spawnJsonRpc}=rpcModule;${erased};return startTurnLoop;`);
  const actual=load(coreModule,fsModule,pathModule,itemsModule,rpcModule,openSession),loop=await actual(t.opts),write=fs.writeSync;
  fs.writeSync=((fd:number,data:any,...args:any[])=>{if(String(data).includes('"type":"revision-receipt-return-confirmed"'))throw new Error('SYNTHETIC_CONFIRMATION_FAILURE');return (write as any)(fd,data,...args);}) as typeof fs.writeSync;syncBuiltinESMExports();
  try{await assert.rejects(loop.close(),/SYNTHETIC_CONFIRMATION_FAILURE/);}finally{fs.writeSync=write;syncBuiltinESMExports();}
  assert.equal(shutdowns,1);assert.equal(inspectSession({...t.opts}).lock,null);
  const resumed=await actual(t.opts);await resumed.close();assert.equal(shutdowns,2);
});
