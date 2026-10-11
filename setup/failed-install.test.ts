import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tree, world } from './testing/world.ts';

const CODEX_CONFIG = '# my codex config\nmodel = "gpt-6-luna" # inline\n\n[projects."/tmp/x"]\ntrust_level = "trusted"\n';

test('[LIFE-003] failed Codex install removes the staged marketplace and names a real backup', () => {
  const w = world();
  const config = join(w.codexHome, 'config.toml');
  writeFileSync(config, CODEX_CONFIG);
  const r = w.ce(['install'], { env: { FAKE_CODEX_FAIL: 'plugin add' } });
  assert.equal(r.status, 1, r.stdout);
  assert.equal(existsSync(join(w.stateDir, 'setup', 'codex-marketplace')), false);
  assert.equal(existsSync(join(w.stateDir, 'setup', 'codex.json')), false);
  assert.equal(readFileSync(config, 'utf8'), CODEX_CONFIG);
  assert.equal(existsSync(join(w.codexHome, 'plugins', 'cache', 'context-engine')), false);

  const before = /before backups: (\/\S+)$/m.exec(r.stderr)?.[1];
  assert.ok(before, r.stderr);
  assert.deepEqual(readdirSync(before), ['0-config.toml']);
  assert.equal(readFileSync(join(before, '0-config.toml'), 'utf8'), CODEX_CONFIG);
  assert.deepEqual(Object.keys(tree(join(before, '..'))).sort(), ['after/', 'before/', 'before/0-config.toml']);
});
