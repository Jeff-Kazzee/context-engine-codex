import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';
import test from 'node:test';
import { pnpmVersionError, pnpmPinError, pnpmRuntimeError } from './check-pnpm.mjs';
import { inputError } from './check-inputs.mjs';

test('the manager policy accepts only its reviewed exact artifact version', () => {
  assert.equal(pnpmVersionError('11.28.6'), null);
  for (const version of ['11.4.0', '11.9.0', '11.11.0', '11.28.5', '11.28.7', '12.0.0', 'v11.28.6', '11.28.6-rc.1', '11.28.6\n', '']) {
    assert.ok(pnpmVersionError(version), JSON.stringify(version));
  }
  const policy = { packageManager: 'pnpm@11.28.6' };
  assert.equal(pnpmPinError(policy), null);
  assert.equal(pnpmRuntimeError(policy, () => '11.28.6'), null);
  assert.ok(pnpmRuntimeError(policy, () => '11.11.0'));
  assert.ok(pnpmRuntimeError(policy, () => { throw new Error('failed'); }));
  assert.ok(pnpmPinError({ ...policy, devEngines: { packageManager: 'other' } }));
});

test('frozen inputs and unexpected ancestor configuration fail before manager setup', () => {
  const root = join(process.cwd(), 'ce-input-fixture');
  const text = '{"private":true}\n';
  const digest = createHash('sha256').update(text).digest('hex');
  const policy = { inputs: { 'package.json': digest, 'package-lock.json': digest } };
  const absent = () => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); };
  const files = fallback => path => Object.hasOwn(policy.inputs, basename(path)) ? { isFile: () => true } : fallback(path);
  assert.equal(inputError(root, policy, () => text, files(absent)), null);
  assert.match(inputError(root, policy, () => '{"workspaces":["{{{{"]}', files(absent)), /Unreviewed CI input/);
  assert.match(inputError(root, policy, () => text, () => ({ isFile: () => false })), /Require a regular CI input/);
  for (const name of ['yarn.lock', '.yarnrc.yml', 'npm-shrinkwrap.json', 'package.yaml', 'package.json5', 'pnpm-workspace.yaml', '.npmrc', '.pnpmfile.mjs', '.pnpmfile.cjs']) {
    const unexpected = files(path => basename(path) === name ? {} : absent());
    assert.match(inputError(root, policy, () => text, unexpected), /Unreviewed manager configuration/, name);
  }
  assert.throws(() => inputError(root, policy, () => text, files(() => { throw new Error('unreadable'); })), /unreadable/);
});
