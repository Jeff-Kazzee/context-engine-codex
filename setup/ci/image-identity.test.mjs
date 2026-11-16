import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const docker = readFileSync(new URL('../../.github/actions/security-ci/Dockerfile', import.meta.url), 'utf8');
const setup = docker.match(/^RUN case[\s\S]*?(?=\nCOPY )/m)?.[0].replace(/^RUN /, '').replace(/\\\n/g, '');
assert.ok(setup, 'Exercise the actual image account setup, without running an image or host account tools');

function accountSetup(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ce-image-identity-'));
  try {
    const bin = join(root, 'bin'), log = join(root, 'calls');
    mkdirSync(bin);
    const fake = (name, body) => writeFileSync(join(bin, name), '#!/bin/sh\n' + body, { mode: 0o700 });
    fake('getent', 'printf "getent %s\\n" "$*" >> "$CALL_LOG"\ncase "$1" in group) test "$HAS_GROUP" = 1;; passwd) test "$HAS_USER" = 1;; *) exit 2;; esac\n');
    fake('groupadd', 'printf "groupadd %s\\n" "$*" >> "$CALL_LOG"\nexit "${GROUPADD_EXIT:-0}"\n');
    fake('useradd', 'printf "useradd %s\\n" "$*" >> "$CALL_LOG"\ntest "$HAS_USER" != 1 || exit 4\nexit "${USERADD_EXIT:-0}"\n');
    const result = spawnSync('/bin/sh', ['-c', setup], {
      env: { PATH: bin, CALL_LOG: log, CE_UID: '1000', CE_GID: '1000', HAS_USER: '1', HAS_GROUP: '1', ...overrides },
      encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(result.error, undefined);
    assert.ok(Number.isInteger(result.status));
    let calls = '';
    try { calls = readFileSync(log, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return { ...result, calls };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('the image reuses occupied UID/GID 1000 without changing existing accounts', () => {
  const result = accountSetup();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.calls, 'getent group 1000\ngetent passwd 1000\n');
});

test('fresh image IDs create only the requested group and non-home user', () => {
  const result = accountSetup({ CE_UID: '2001', CE_GID: '2002', HAS_USER: '0', HAS_GROUP: '0' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.calls, 'getent group 2002\ngroupadd --gid 2002 ce-ci\ngetent passwd 2001\nuseradd --no-create-home --uid 2001 --gid 2002 --shell /bin/bash ce-ci\n');
});

test('a fresh image UID can use an existing numeric GID', () => {
  const result = accountSetup({ HAS_USER: '0' });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.calls, /^groupadd /m);
  assert.match(result.calls, /^useradd --no-create-home --uid 1000 --gid 1000 /m);
});

test('an existing image UID can use a fresh explicitly selected workload GID', () => {
  const result = accountSetup({ CE_GID: '2002', HAS_GROUP: '0' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.calls, 'getent group 2002\ngroupadd --gid 2002 ce-ci\ngetent passwd 1000\n');
});

for (const value of ['1', '4294967294']) {
  test(`image identity accepts valid nonroot boundary ${value}`, () => {
    const result = accountSetup({ CE_UID: value, CE_GID: value });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.calls, `getent group ${value}\ngetent passwd ${value}\n`);
  });
}

for (const variable of ['CE_UID', 'CE_GID']) {
  for (const value of ['', '0', '00', '01000', '-1', 'abc', '4294967295', '4294967296', '99999999999999999999999999999999']) {
    test(`image ${variable} refuses invalid ID ${JSON.stringify(value)} before any account command`, () => {
      const result = accountSetup({ [variable]: value });
      assert.notEqual(result.status, 0);
      assert.equal(result.calls, '');
    });
  }
}

test('group creation errors stop before user lookup or creation', () => {
  const result = accountSetup({ HAS_GROUP: '0', HAS_USER: '0', GROUPADD_EXIT: '9' });
  assert.equal(result.status, 9);
  assert.doesNotMatch(result.calls, /passwd|useradd/);
});

test('user creation errors remain failures', () => {
  const result = accountSetup({ HAS_USER: '0', USERADD_EXIT: '9' });
  assert.equal(result.status, 9);
});
