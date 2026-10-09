import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { world } from './testing/world.ts';

test('[CLI-010] Codex package bins map to core/cli.ts and the turn loop', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(pkg.bin, { 'context-engine': 'core/cli.ts', 'context-engine-codex': 'core/cli.ts', 'context-engine-codex-turns': 'adapters/codex/turn-loop/cli.ts' });
  for (const entry of ['../core/cli.ts', '../adapters/codex/turn-loop/cli.ts']) {
    assert.equal(readFileSync(new URL(entry, import.meta.url), 'utf8').split('\n')[0], '#!/usr/bin/env node', entry);
  }
});

test('[CLI-010] the shared entry routes setup commands to this checkout by argv alone', () => {
  const w = world();
  const status = w.ce(['status', '--json']);
  assert.equal(status.status, 0, status.stderr);
  assert.ok('codex' in JSON.parse(status.stdout), status.stdout);
  const help = w.ce(['install', '--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /^context-engine-codex\n/);
});
