import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { world, tree } from './testing/world.ts';
const runtime: string = 'codex';
test('default install and uninstall change only the selected runner and restore exact bytes', () => {
  const w = world();
  writeFileSync(join(w.claudeHome, 'settings.json'), '{"theme":"dark"}\n');
  writeFileSync(join(w.codexHome, 'config.toml'), '# retain this comment\nmodel = "test"\n');
  const beforeClaude = tree(w.claudeHome), beforeCodex = tree(w.codexHome);
  const inst = w.ce(['install']); assert.equal(inst.status, 0, inst.stdout + inst.stderr);
  if (runtime === 'claude') assert.deepEqual(tree(w.codexHome), beforeCodex);
  else assert.deepEqual(tree(w.claudeHome), beforeClaude);
  // A stale other-runner ledger must not be read or acted on by this distribution.
  writeFileSync(join(w.stateDir,'setup','claude.json'),'invalid-other-runner-ledger');
  const enabled = w.ce(['enable']); assert.equal(enabled.status, 0, enabled.stdout + enabled.stderr);
  if (runtime === 'claude') assert.equal(existsSync(join(w.project, '.codex')), false);
  const status = w.ce(['status']); assert.equal(status.status, 0, status.stdout + status.stderr);
  assert.equal(w.ce(['disable']).status, 0);
  assert.equal(w.ce(['uninstall']).status, 0);
  assert.deepEqual(tree(w.claudeHome), beforeClaude); assert.deepEqual(tree(w.codexHome), { ...beforeCodex, '.tmp/': 'dir', '.tmp/marketplaces/': 'dir', 'plugins/': 'dir', 'plugins/cache/': 'dir' });
});
test('wrong runner install refuses before changing either home', () => {
 const w = world(); const a=tree(w.claudeHome), b=tree(w.codexHome);
 const r=w.ce(['install', '--claude']); assert.equal(r.status,1);assert.match(r.stderr,/supports codex only/);
 assert.deepEqual(tree(w.claudeHome),a); assert.deepEqual(tree(w.codexHome),b);
});
test('shared core hashes match the pinned source manifest', async () => {
 const {createHash}=await import('node:crypto');
 const root=new URL('../',import.meta.url); const source=JSON.parse(readFileSync(new URL('SOURCE.json',root),'utf8'));
 for(const [path,sha] of Object.entries(source.coreSha256)) assert.equal(createHash('sha256').update(readFileSync(new URL(path,root))).digest('hex'),sha,path);
});

test('failed installation restores both runner homes and can be retried', () => {
 const w=world(); writeFileSync(join(w.claudeHome,'settings.json'),'{}\n'); writeFileSync(join(w.codexHome,'config.toml'),'# keep\n');
 const a=tree(w.claudeHome),b=tree(w.codexHome);
 const r=w.ce(['install'],{env:{FAKE_CODEX_FAIL: 'plugin add'}});
 assert.equal(r.status,1,r.stdout+r.stderr);assert.match(r.stderr,/tracked configuration rollback completed/);
 assert.deepEqual(tree(w.claudeHome),a);assert.deepEqual(tree(w.codexHome),{...b, '.tmp/':'dir', '.tmp/marketplaces/':'dir'});
 assert.equal(w.ce(['install']).status,0);assert.equal(w.ce(['install']).status,1);assert.equal(w.ce(['uninstall']).status,0);
});
