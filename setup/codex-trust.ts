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
    if (ours.length !== CODEX_HOOK_COUNT) return [`Hooks: Codex lists ${ours.length} Context Engine hooks, expected ${CODEX_HOOK_COUNT}; none trusted. Check them with /hooks in Codex.`];
    const edits = ours.map((h) => ({ keyPath: `hooks.state.${JSON.stringify(h.key)}.trusted_hash`, value: h.currentHash, mergeStrategy: 'replace' }));
    await rpc.request('config/batchWrite', { edits });
    const trusted = (await list()).filter((h) => h.trustStatus === 'trusted').length;
    return [`Hooks: ${trusted}/${CODEX_HOOK_COUNT} trusted through Codex's app-server (--trust-hooks)`];
  } finally {
    await rpc.close();
  }
}
