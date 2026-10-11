import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { world } from './testing/world.ts';

const SEED = [
  '# my codex config',
  'model = "gpt-6-luna"',
  '',
  '[marketplaces.mkt]',
  'source_type = "local"',
  'source = "/opt/mkt"',
  '',
  '[plugins."other@mkt"]',
  'enabled = true',
  '',
  '[hooks.state."other@mkt:hooks/hooks.json:stop:0:0"]',
  `trusted_hash = "sha256:${'a'.repeat(64)}"`,
  '',
].join('\n');

test('[LIFE-008] Codex uninstall keeps another plugin and its trust tables', () => {
  const w = world();
  const config = join(w.codexHome, 'config.toml');
  writeFileSync(config, SEED);
  for (const args of [['install', '--trust-hooks'], ['enable'], ['disable'], ['uninstall']]) {
    const r = w.ce(args);
    assert.equal(r.status, 0, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
    if (args[0] === 'install') assert.match(r.stdout, /Hooks: 5\/5 trusted/);
  }
  assert.equal(readFileSync(config, 'utf8'), SEED);
});
