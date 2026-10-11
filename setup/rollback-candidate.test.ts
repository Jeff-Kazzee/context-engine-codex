import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tempDir } from '../core/testing.ts';
import { assess, completeLedger, revert, takeSnapshot } from './ledger.ts';
import { jsonRule } from './rules.ts';

test('[LIFE-009] refused replacement reports a recoverable candidate', () => {
  const root = tempDir('candidate'), file = join(root, 'settings.json'), rules = { [file]: jsonRule([['owned']]) };
  fs.writeFileSync(file, '{"theme":"before"}');
  const snap = takeSnapshot({ backupRoot: join(root, 'backups'), kind: 'test', files: [file], watch: [], namespaced: [] });
  fs.writeFileSync(file, '{"theme":"before","owned":true}');
  const ledger = completeLedger(snap), unchanged = assess(ledger, rules);
  const captured = '{"theme":"captured-unmanaged","owned":true}', newer = '{"theme":"newer-destination"}';
  const native = fs.renameSync;
  let raced = false;
  fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
    const capture = !raced && String(to).includes('.context-engine-replace-');
    if (capture) { raced = true; fs.writeFileSync(file, captured); }
    native(from, to);
    if (capture) fs.writeFileSync(file, newer);
  }) as typeof fs.renameSync;
  syncBuiltinESMExports();
  let message = '';
  try { assert.throws(() => revert(ledger, rules, unchanged), (e: Error) => { message = e.message; return /captured candidate remains at/.test(message); }); }
  finally { fs.renameSync = native; syncBuiltinESMExports(); }

  assert.equal(raced, true);
  assert.equal(fs.readFileSync(file, 'utf8'), newer, 'the newer destination is retained');
  const candidate = /captured candidate remains at (\S+)$/.exec(message)?.[1];
  assert.ok(candidate, message);
  assert.ok(candidate.startsWith(join(root, '.context-engine-replace-')), message);
  assert.equal(fs.readFileSync(candidate, 'utf8'), captured, 'the named candidate holds the captured bytes');
});
