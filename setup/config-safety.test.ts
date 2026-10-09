import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../core/testing.ts';
import { takeSnapshot } from './ledger.ts';

test('[SAFE-010] inline TOML table refuses before any backup', () => {
  const root = tempDir('inline-table'), config = join(root, 'config.toml'), backupRoot = join(root, 'backups');
  const text = '[tools]\nx = { a = 1 }\n';
  writeFileSync(config, text);
  assert.throws(() => takeSnapshot({ backupRoot, kind: 'synthetic', files: [config], watch: [], namespaced: [] }), /unsafe configuration cannot be backed up/);
  assert.equal(existsSync(backupRoot), false);
  assert.equal(readFileSync(config, 'utf8'), text);
});
