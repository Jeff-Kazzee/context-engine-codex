import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../core/testing.ts';
import { world } from './testing/world.ts';

const pointerFile = (stateDir: string) => {
  const dir = join(stateDir, 'setup', 'projects');
  const [name, ...rest] = readdirSync(dir);
  assert.equal(rest.length, 0, 'one project pointer');
  return join(dir, name!);
};

test('[LIFE-013] pointer naming a different project root refuses uninstall', () => {
  const w = world();
  assert.equal(w.ce(['install']).status, 0);
  assert.equal(w.ce(['enable']).status, 0);
  const other = tempDir('other-project');
  mkdirSync(join(other, '.codex'));
  writeFileSync(join(other, '.codex', 'config.toml'), 'model = "other"\n');
  const pointer = pointerFile(w.stateDir);
  writeFileSync(pointer, `${JSON.stringify({ ...JSON.parse(readFileSync(pointer, 'utf8')), projectRoot: other })}\n`);
  const configs = [join(w.project, '.codex', 'config.toml'), join(other, '.codex', 'config.toml')];
  const before = configs.map((path) => readFileSync(path, 'utf8'));

  const r = w.ce(['uninstall']);
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /confinement policy/);
  assert.deepEqual(configs.map((path) => readFileSync(path, 'utf8')), before);
  assert.equal(existsSync(join(w.stateDir, 'setup', 'codex.json')), true);
});

test('[LIFE-013] missing-project uninstall keeps the project backups', () => {
  const w = world();
  mkdirSync(join(w.project, '.codex'));
  writeFileSync(join(w.project, '.codex', 'config.toml'), 'model = "project"\n');
  assert.equal(w.ce(['install']).status, 0);
  assert.equal(w.ce(['enable']).status, 0);
  const pointer = pointerFile(w.stateDir);
  rmSync(w.project, { recursive: true });

  const r = w.ce(['uninstall'], { cwd: w.home });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /missing or moved; project files were left untouched and backups preserved/);
  const retired = JSON.parse(readFileSync(pointer, 'utf8'));
  assert.equal(retired.retired, true);
  assert.equal(readFileSync(join(retired.dir, 'before', '0-config.toml'), 'utf8'), 'model = "project"\n');
  assert.ok(existsSync(join(retired.dir, 'ledger.json')));
});
