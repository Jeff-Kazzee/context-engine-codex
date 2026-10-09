import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tree, world } from './testing/world.ts';

test('[LIFE-010] inline table in tracked config refuses install before backup', () => {
  const w = world();
  const config = join(w.codexHome, 'config.toml');
  const text = '[tools]\nx = { a = 1 }\n';
  writeFileSync(config, text);
  const home = tree(w.codexHome);
  const r = w.ce(['install']);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /unsafe configuration cannot be backed up/);
  assert.equal(existsSync(join(w.stateDir, 'setup', 'backups')), false);
  assert.equal(readFileSync(config, 'utf8'), text);
  assert.deepEqual(tree(w.codexHome), home);
});

test('[LIFE-010] uninstall strips Context Engine tables written in an equivalent spelling', () => {
  const w = world();
  const config = join(w.codexHome, 'config.toml');
  const original = '# my codex config\nmodel = "gpt-6-luna"\n';
  writeFileSync(config, original);
  assert.equal(w.ce(['install']).status, 0);
  const installed = readFileSync(config, 'utf8');
  assert.ok(installed.includes('[plugins."context-engine@context-engine"]'), installed);
  writeFileSync(config, `${installed.replace('[plugins."context-engine@context-engine"]', "[ plugins . 'context-engine@context-engine' ]")}\n[ hooks . state . "context-engine@context-engine:hooks/hooks.json:stop:0:0" ]\ntrusted_hash = "sha256:${'b'.repeat(64)}"\n`);

  const un = w.ce(['uninstall']);
  assert.equal(un.status, 0, un.stdout + un.stderr);
  const left = readFileSync(config, 'utf8');
  assert.doesNotMatch(left, /context-engine@context-engine/, `a Context Engine table survived uninstall:\n${left}`);
  assert.equal(left, original);
});
