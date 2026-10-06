import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../../../core/testing.ts';
import { RpcError, spawnJsonRpc } from './jsonrpc.ts';
import { FAKE_APP_SERVER } from './testing/fake.ts';

test('failed spawn rejects initialize and close settles without an exit event', async () => {
  const dir = tempDir('missing-codex');
  const rpc = spawnJsonRpc([join(dir, 'nonexistent-executable')], { cwd: dir });
  await assert.rejects(rpc.request('initialize'), /could not run/);
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([rpc.close(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('close hung after failed spawn')), 300);
    })]);
  } finally { clearTimeout(timer); }
});

function fake(script: object = {}) {
  const dir = tempDir('fake-codex');
  const logPath = join(dir, 'log.jsonl');
  const scriptPath = join(dir, 'script.json');
  writeFileSync(scriptPath, JSON.stringify(script));
  const rpc = spawnJsonRpc([process.execPath, FAKE_APP_SERVER], {
    cwd: dir,
    env: { ...process.env, FAKE_CODEX_LOG: logPath, FAKE_CODEX_SCRIPT: scriptPath },
  });
  const log = () =>
    readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, any>);
  return { rpc, log };
}

test('responses are matched by id while notifications interleave', async () => {
  const { rpc } = fake({ turns: [{ reply: 'hello' }] });
  try {
    const seen: Array<{ method: string; params: any }> = [];
    rpc.onNotification((n) => seen.push(n));
    const init = await rpc.request<{ userAgent: string }>('initialize', { clientInfo: { name: 't', version: '0' } });
    assert.equal(init.userAgent, 'fake-app-server/0');
    rpc.notify('initialized');
    const { thread } = await rpc.request<{ thread: { id: string } }>('thread/start', {});
    const { turn } = await rpc.request<{ turn: { id: string } }>('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'hi' }] });
    while (!seen.some((n) => n.method === 'turn/completed')) await new Promise((r) => setTimeout(r, 5));
    assert.equal(seen.at(-1)!.params.turn.id, turn.id);
    assert.ok(seen.some((n) => n.method === 'item/completed' && n.params.item.text === 'hello'));
  } finally {
    await rpc.close();
  }
});

test('a JSON-RPC error rejects with its code and message', async () => {
  const { rpc } = fake({ errors: { 'thread/start': { code: -32600, message: 'turn not found: x' } } });
  try {
    await assert.rejects(rpc.request('thread/start', {}), (e: unknown) => e instanceof RpcError && e.code === -32600 && /turn not found/.test(e.message));
  } finally {
    await rpc.close();
  }
});

test('server-to-client requests are refused, never left hanging', async () => {
  const { rpc, log } = fake({ turns: [{ serverRequest: true }] });
  try {
    let done = false;
    rpc.onNotification((n) => {
      if (n.method === 'turn/completed') done = true;
    });
    const { thread } = await rpc.request<{ thread: { id: string } }>('thread/start', {});
    await rpc.request('turn/start', { threadId: thread.id, input: [] });
    while (!done) await new Promise((r) => setTimeout(r, 5));
    const answer = log().find((e) => e.serverRequestAnswer)!.serverRequestAnswer;
    assert.equal(answer.id, 'srv-1');
    assert.equal(answer.error.code, -32601);
  } finally {
    await rpc.close();
  }
});

test('if the server exits, pending requests reject instead of hanging', async () => {
  const { rpc } = fake({ exitOn: 'thread/start' });
  try {
    await assert.rejects(rpc.request('thread/start', {}), /exited/);
  } finally {
    await rpc.close();
  }
});
