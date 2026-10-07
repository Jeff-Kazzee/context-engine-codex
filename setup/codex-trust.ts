// `install --codex --trust-hooks`: Codex runs a plugin's hooks only once each is trusted. With the
// user's explicit flag, trust Context Engine's hooks the way Codex's own /hooks screen does: ask
// Codex's app-server (our own stdio instance, never the shared daemon socket) for the hooks and
// their current hashes, then write those hashes through its config/batchWrite. Only hooks of our
// plugin id are touched. Uninstall removes the trust entries again (ledger rules).
import { spawnJsonRpc } from '../adapters/codex/turn-loop/jsonrpc.ts';
import { CODEX_HOOK_COUNT, CODEX_PLUGIN_ID, type RunnerSpec, type SetupContext } from './runners.ts';

interface HookInfo {
  key: string;
  pluginId?: string;
  currentHash: string;
  trustStatus: string;
}

/** Read current hook trust from the runner. Never edits configuration. */
export async function currentCodexTrust(ctx: SetupContext, spec: RunnerSpec): Promise<number> {
  const bin = /\.[cm]?[jt]s$/.test(spec.bin) ? [process.execPath, spec.bin] : [spec.bin];
  const rpc = spawnJsonRpc([...bin, 'app-server', '--listen', 'stdio://'], { cwd: ctx.codexHome, env: ctx.env, timeoutMs: 10_000 });
  try {
    await rpc.request('initialize', { clientInfo: { name: 'context-engine-status', version: '0.1.0' }, capabilities: { experimentalApi: false } });
    rpc.notify('initialized');
    const r = await rpc.request<{ data: Array<{ hooks: HookInfo[] }> }>('hooks/list', { cwds: [ctx.codexHome] });
    const ours = (r.data[0]?.hooks ?? []).filter(h => h.pluginId === CODEX_PLUGIN_ID);
    if (ours.length !== CODEX_HOOK_COUNT || new Set(ours.map(h => h.key)).size !== CODEX_HOOK_COUNT) return 0;
    return ours.filter(h => h.trustStatus === 'trusted' && typeof h.currentHash === 'string' && h.currentHash.length > 0).length;
  } catch { return 0; } finally { await rpc.close(); }
}

export async function trustCodexHooks(ctx: SetupContext, spec: RunnerSpec): Promise<string[]> {
  const bin = /\.[cm]?[jt]s$/.test(spec.bin) ? [process.execPath, spec.bin] : [spec.bin];
  const rpc = spawnJsonRpc([...bin, 'app-server', '--listen', 'stdio://'], { cwd: ctx.codexHome, env: ctx.env, timeoutMs: 60_000 });
  try {
    await rpc.request('initialize', { clientInfo: { name: 'context-engine-setup', version: '0.1.0' }, capabilities: { experimentalApi: false } });
    rpc.notify('initialized');
    const list = async () => {
      const r = await rpc.request<{ data: Array<{ hooks: HookInfo[] }> }>('hooks/list', { cwds: [ctx.codexHome] });
      return (r.data[0]?.hooks ?? []).filter((h) => h.pluginId === CODEX_PLUGIN_ID);
    };
    const ours = await list();
    if (ours.length !== CODEX_HOOK_COUNT || new Set(ours.map(h => h.key)).size !== CODEX_HOOK_COUNT || ours.some(h => typeof h.key !== 'string' || !h.key || typeof h.currentHash !== 'string' || !h.currentHash)) {
      throw new Error(`Hooks: expected ${CODEX_HOOK_COUNT} distinct Context Engine hooks with current hashes; none trusted. Check /hooks in Codex. Installed files are retained.`);
    }
    const edits = ours.map((h) => ({ keyPath: `hooks.state.${JSON.stringify(h.key)}.trusted_hash`, value: h.currentHash, mergeStrategy: 'replace' }));
    await rpc.request('config/batchWrite', { edits });
    const after = await list();
    const expected = new Map(ours.map(h => [h.key, h.currentHash]));
    if (after.length !== CODEX_HOOK_COUNT || new Set(after.map(h => h.key)).size !== CODEX_HOOK_COUNT || after.some(h => h.trustStatus !== 'trusted' || expected.get(h.key) !== h.currentHash)) {
      throw new Error('Hooks: trust verification failed; installed files are retained. Check the current hashes with /hooks in Codex.');
    }
    const trusted = after.length;
    return [`Hooks: ${trusted}/${CODEX_HOOK_COUNT} trusted through Codex's app-server (--trust-hooks)`];
  } finally {
    await rpc.close();
  }
}
