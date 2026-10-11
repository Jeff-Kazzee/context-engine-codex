// The pinned native Codex binary, offline: it lists the installed plugin's five hooks, trusts them
// through its own app-server, and renders Context Engine guidance only in the enabled project.
// CI runs this file under `unshare --net` with CONTEXT_ENGINE_NATIVE_CODEX set (.github/workflows/ci.yml).
// Without that variable it is skipped. It runs no hook event, so it is setup and status evidence,
// not delivery evidence.
import '../adapters/codex/testing/private-tmp.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../core/testing.ts';
import { world } from './testing/world.ts';

const NATIVE = process.env.CONTEXT_ENGINE_NATIVE_CODEX;
const VERSION = 'codex-cli 0.161.0';

test('[CDX-023] the pinned native Codex reports the reset mode only after it trusts all five hooks, and other projects keep their input', {
  skip: NATIVE ? false : 'CONTEXT_ENGINE_NATIVE_CODEX does not name a pinned native Codex binary',
}, () => {
  const codex = NATIVE!;
  const version = spawnSync(codex, ['--version'], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(version.stdout.trim(), VERSION, version.stderr);
  const w = world(), enabled = tempDir('enabled-project'), native = { CONTEXT_ENGINE_CODEX_BIN: codex };
  const config = `# scratch\n\n[projects.${JSON.stringify(w.project)}]\ntrust_level = "trusted"\n\n[projects.${JSON.stringify(enabled)}]\ntrust_level = "trusted"\n`;
  writeFileSync(join(w.codexHome, 'config.toml'), config);
  const promptInput = (cwd: string): unknown => {
    const r = spawnSync(codex, ['debug', 'prompt-input', '-c', 'suppress_unstable_features_warning=true', 'hello'], { cwd, encoding: 'utf8', env: { ...process.env, ...w.env }, timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);
    const strip = (v: unknown): unknown => Array.isArray(v) ? v.map(strip)
      : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'id' && k !== 'create_time').map(([k, x]) => [k, strip(x)])) : v;
    return strip(JSON.parse(r.stdout.slice(r.stdout.indexOf('['))));
  };
  const without = promptInput(w.project);

  const install = w.ce(['install', '--codex', '--trust-hooks'], { env: native });
  assert.equal(install.status, 0, install.stdout + install.stderr);
  assert.match(install.stdout, /Hooks: 5\/5 trusted/);
  assert.equal(w.ce(['enable'], { cwd: enabled, env: native }).status, 0);
  const status = JSON.parse(w.ce(['status', '--json'], { cwd: enabled, env: native }).stdout).codex;
  assert.deepEqual([status.active, status.hookTrustEntries, status.guidanceSeen], [true, 5, true], JSON.stringify(status));
  assert.match(JSON.stringify(promptInput(enabled)), /Context Engine manages this context window/);
  assert.deepEqual(promptInput(w.project), without, 'a project nobody enabled sees the same model input');

  assert.equal(w.ce(['disable'], { cwd: enabled, env: native }).status, 0);
  const uninstall = w.ce(['uninstall', '--codex'], { env: native });
  assert.equal(uninstall.status, 0, uninstall.stdout + uninstall.stderr);
  assert.equal(readFileSync(join(w.codexHome, 'config.toml'), 'utf8'), config);
  assert.equal(existsSync(join(w.codexHome, 'plugins', 'cache', 'context-engine')), false);
  assert.deepEqual(promptInput(w.project), without);
});
