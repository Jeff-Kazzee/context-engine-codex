import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { world } from './testing/world.ts';

test('wave9: missing project cannot bypass malformed backup ledger validation', () => {
  const w = world(); assert.equal(w.ce(['install']).status, 0); assert.equal(w.ce(['enable']).status, 0);
  const pointers = join(w.stateDir, 'setup/projects');
  const pointer = join(pointers, fs.readdirSync(pointers)[0]!);
  const metadata = JSON.parse(fs.readFileSync(pointer, 'utf8'));
  fs.writeFileSync(join(metadata.dir, 'ledger.json'), '{}', { mode: 0o600 });
  fs.rmSync(w.project, { recursive: true });
  const result = w.ce(['uninstall'], { cwd: w.home });
  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(w.project), false);
  assert.equal(fs.existsSync(pointer), true);
  assert.equal(fs.existsSync(join(w.stateDir, 'setup/codex.json')), true);
});

for (const missing of ['deleted', 'moved']) test('wave9: uninstall succeeds without recreating a ' + missing + ' enabled project', () => {
  const w = world(), original = w.project, moved = `${original}-moved`;
  assert.equal(w.ce(['install']).status, 0);
  assert.equal(w.ce(['enable']).status, 0);
  const config = fs.readFileSync(join(original, '.codex/config.toml'));
  if (missing === 'moved') fs.renameSync(original, moved);
  else fs.rmSync(original, { recursive: true });
  const result = w.ce(['uninstall'], { cwd: w.home });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /missing|moved|unavailable/);
  assert.equal(fs.existsSync(original), false);
  assert.equal(fs.existsSync(join(w.stateDir, 'setup/codex.json')), false);
  if (missing === 'moved') assert.deepEqual(fs.readFileSync(join(moved, '.codex/config.toml')), config, 'do not locate or alter moved private projects');
});
