import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../core/testing.ts';
import { assertBackupSafe } from './config-safety.ts';
import { takeSnapshot } from './ledger.ts';

test('[SAFE-010] inline TOML table refuses before any backup', () => {
  const root = tempDir('inline-table'), config = join(root, 'config.toml'), backupRoot = join(root, 'backups');
  const text = '[tools]\nx = { a = 1 }\n';
  writeFileSync(config, text);
  assert.throws(() => takeSnapshot({ backupRoot, kind: 'synthetic', files: [config], watch: [], namespaced: [] }), /unsafe configuration cannot be backed up/);
  assert.equal(existsSync(backupRoot), false);
  assert.equal(readFileSync(config, 'utf8'), text);
});

test('[SAFE-010] trusted project path ending in token is not a credential key', () => {
  for (const path of ['/tmp/api-token', '/home/u/password', '/srv/client.secret']) {
    for (const header of [`[projects.${JSON.stringify(path)}]`, `[projects.'${path}']`]) {
      assert.doesNotThrow(() => assertBackupSafe('config.toml', Buffer.from(`${header}\ntrust_level = "trusted"\n`)), header);
    }
  }
  for (const text of ['[tokens."/tmp/x"]\ntrust_level = "trusted"\n', '[projects."/tmp/x".auth]\nv = "x"\n', '[projects."/tmp/x"]\napi_token = "SYNTHETIC_ONLY"\n', '[projects."relative-token"]\ntrust_level = "trusted"\n']) {
    assert.throws(() => assertBackupSafe('config.toml', Buffer.from(text)), /credential-bearing or unsafe configuration/, text);
  }
});
