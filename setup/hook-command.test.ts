// Codex runs each staged hook command through `$SHELL -lc`. The command must survive the checkout
// path's shell quoting and reach the core from Codex's cached plugin copy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { tempDir } from '../core/testing.ts';
import { setParticipation } from '../core/index.ts';
import { startBounded } from '../adapters/codex/testing/hook-process.ts';
import { world } from './testing/world.ts';

test('[CDX-015] the staged hook command runs through a login shell from a checkout path with a space and a quote', async () => {
  const source = fileURLToPath(new URL('..', import.meta.url));
  const checkout = join(tempDir('checkout'), "check out's", 'context-engine-codex');
  for (const part of ['core', 'setup', 'adapters/codex', 'package.json']) cpSync(join(source, part), join(checkout, part), { recursive: true });
  const w = world();
  const install = spawnSync(process.execPath, [join(checkout, 'core', 'cli.ts'), 'install', '--codex'], { cwd: w.project, encoding: 'utf8', env: { ...process.env, ...w.env }, timeout: 60_000 });
  assert.equal(install.status, 0, install.stdout + install.stderr);

  const version = JSON.parse(readFileSync(join(source, 'adapters', 'codex', 'plugin', '.codex-plugin', 'plugin.json'), 'utf8')).version;
  const plugin = join(w.codexHome, 'plugins', 'cache', 'context-engine', 'context-engine', version);
  const command: string = JSON.parse(readFileSync(join(plugin, 'hooks', 'hooks.json'), 'utf8')).hooks.UserPromptSubmit[0].hooks[0].command;
  assert.ok(command.includes(`CONTEXT_ENGINE_CLI='${join(checkout, 'core', 'cli.ts').replaceAll("'", "'\\''")}'`), command);

  setParticipation({ projectRoot: w.project, stateDir: w.stateDir, state: 'on' });
  const event = { session_id: 'S1', cwd: w.project, transcript_path: null, hook_event_name: 'UserPromptSubmit', prompt: 'FROM_THE_STAGED_COMMAND' };
  const run = await startBounded(['bash', '--noprofile', '--norc', '-lc', command], {
    cwd: w.project, env: { ...process.env, ...w.env, PLUGIN_ROOT: plugin, NODE_OPTIONS: '' }, input: JSON.stringify(event), timeoutMs: 30_000,
  }).done;
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr, '');
  assert.match(readFileSync(join(w.project, '.context-engine', 'S1', 'context.md'), 'utf8'), /FROM_THE_STAGED_COMMAND/);
});
