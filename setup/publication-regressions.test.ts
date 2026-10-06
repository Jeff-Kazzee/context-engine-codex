import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { world } from './testing/world.ts';

for (const length of [186, 190, 255]) test(`setup supports project basename ${length} and round-trip rollback`, () => {
  const w = install(), project = join(w.project, 'p'.repeat(length)); mkdirSync(project);
  assert.equal(w.ce(['enable', '--project', project]).status, 0);
  assert.equal(w.ce(['disable', '--project', project]).status, 0);
  assert.equal(existsSync(join(project, '.codex/config.toml')), false);
  assert.equal(w.ce(['uninstall', '--codex']).status, 0);
});

function install() { const w = world(); const r = w.ce(['install', '--codex', '--trust-hooks']); assert.equal(r.status, 0, r.stderr); return w; }
for (const key of ['developer_instructions', '"developer_instructions"', "'developer_instructions'"]) test(`enable refuses ${key} without activating participation`, () => {
  const w = install(); mkdirSync(join(w.project, '.codex'));
  writeFileSync(join(w.project, '.codex/config.toml'), `${key} = "USER_GUIDANCE"\n`);
  const r = w.ce(['enable', '--project', w.project]); assert.notEqual(r.status, 0);
  const status = JSON.parse(w.ce(['status', '--project', w.project, '--json']).stdout);
  assert.equal(status.participation.active, false);
});
for (const key of ['"token_budget"', "'token_budget'"]) test(`quoted ${key} is an actual conflicting setting`, () => {
  const w = install(); mkdirSync(join(w.project, '.codex'));
  writeFileSync(join(w.project, '.codex/config.toml'), `[features]\n${key} = false\n`);
  assert.notEqual(w.ce(['enable', '--project', w.project]).status, 0);
});
test('token_budget in a comment or string does not refuse enable; missing marked blocks are repaired', () => {
  const w = install(); mkdirSync(join(w.project, '.codex'));
  const path = join(w.project, '.codex/config.toml'), before = '# token_budget is mentioned\nmodel = "token_budget"\n';
  writeFileSync(path, before);
  assert.equal(w.ce(['enable', '--project', w.project]).status, 0);
  assert.match(readFileSync(path, 'utf8'), /context-engine \(top-level keys\)/);
  writeFileSync(path, before);
  assert.equal(w.ce(['enable', '--project', w.project]).status, 0);
  assert.match(readFileSync(path, 'utf8'), /context-engine \(top-level keys\)/);
  assert.equal(w.ce(['disable', '--project', w.project]).status, 0);
  assert.equal(readFileSync(path, 'utf8'), before);
});
test('linked project config is refused without reading or backing up its target', () => {
  const w = install(); mkdirSync(join(w.project, '.codex'));
  const outside = join(w.home, 'synthetic-private'), marker = 'SYNTHETIC_PRIVATE_NEVER_COPY'; writeFileSync(outside, marker);
  symlinkSync(outside, join(w.project, '.codex/config.toml'));
  assert.notEqual(w.ce(['enable', '--project', w.project]).status, 0);
  assert.equal(readFileSync(outside, 'utf8'), marker);
  const backups = join(w.stateDir, 'setup/backups');
  for (const dir of readdirSync(backups)) for (const name of readdirSync(join(backups, dir, 'before'))) {
    assert.ok(!readFileSync(join(backups, dir, 'before', name), 'utf8').includes(marker));
  }
});
test('failed project rollback leaves global installation available for retry', () => {
  const w = install(); assert.equal(w.ce(['enable', '--project', w.project]).status, 0);
  const config = join(w.project, '.codex/config.toml'), outside = join(w.home, 'synthetic-outside');
  writeFileSync(outside, 'UNCHANGED'); unlinkSync(config); symlinkSync(outside, config);
  assert.notEqual(w.ce(['uninstall', '--codex']).status, 0);
  assert.ok(existsSync(join(w.stateDir, 'setup/codex.json')));
  unlinkSync(config);
  assert.equal(w.ce(['uninstall', '--codex']).status, 0);
  assert.equal(readFileSync(outside, 'utf8'), 'UNCHANGED');
});
test('stale trust hashes cannot report Codex delivery active', () => {
  const w = install(); assert.equal(w.ce(['enable', '--project', w.project]).status, 0);
  const path = join(w.codexHome, 'config.toml');
  const text = readFileSync(path, 'utf8').replace(/trusted_hash = "[^"]+"/g, 'trusted_hash = "sha256:STALE"');
  writeFileSync(path, text + `\n[projects.${JSON.stringify(w.project)}]\ntrust_level = "trusted"\n`);
  const r = w.ce(['status', '--project', w.project, '--json']); assert.equal(r.status, 0, r.stderr);
  const status = JSON.parse(r.stdout); assert.equal(status.codex.active, false); assert.equal(status.codex.hookTrustEntries, 0);
});

for (const originallyPresent of [false, true]) test(`config repair preserves intervening unmanaged settings (original file ${originallyPresent})`, () => {
  const w = world(); const config = join(w.project, '.codex', 'config.toml');
  if (originallyPresent) { mkdirSync(join(w.project, '.codex'), { recursive: true }); writeFileSync(config, '# original\n'); }
  assert.equal(w.ce(['install']).status, 0); assert.equal(w.ce(['enable']).status, 0);
  writeFileSync(config, '# current user settings\nmodel = "SYNTHETIC_USER_MODEL"\n');
  assert.equal(w.ce(['enable']).status, 0); assert.equal(w.ce(['disable']).status, 0);
  assert.equal(readFileSync(config, 'utf8'), '# current user settings\nmodel = "SYNTHETIC_USER_MODEL"\n');
});

for (const originallyPresent of [false, true]) test(`repair preserves intentional config deletion (original file ${originallyPresent})`, () => {
  const w = world(), config = join(w.project, '.codex', 'config.toml');
  if (originallyPresent) { mkdirSync(join(w.project, '.codex'), { recursive: true }); writeFileSync(config, '# initial\n'); }
  assert.equal(w.ce(['install']).status, 0); assert.equal(w.ce(['enable']).status, 0);
  unlinkSync(config); assert.equal(w.ce(['enable']).status, 0); assert.equal(w.ce(['disable']).status, 0);
  assert.equal(existsSync(config), false);
});
