import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const source = readFileSync(new URL('../../.github/actions/security-ci/run.sh', import.meta.url), 'utf8');
// Execute the actual CI phase block with a stand-in command; no test body is rewritten.
const block = source.match(/^  \(\n    compile_cache=\$\(umask 077; mktemp -d [\s\S]*?^  \)/m)?.[0];
assert.ok(block, 'CI has a bounded-scope compile-cache block');
const args = ['--test', '--test-concurrency=1', 'core/**/*.test.ts', 'setup/*.test.ts', 'adapters/codex/**/*.test.ts', 'setup/*.test.mjs', 'setup/ci/*.test.mjs'];

function world() {
  const root = mkdtempSync(join(tmpdir(), 'ce-ci-cache-'));
  const home = join(root, 'home'), bin = join(root, 'bin');
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(bin, { mode: 0o700 });
  writeFileSync(join(bin, 'node'), `#!/bin/bash
set -euo pipefail
test -n "\${NODE_COMPILE_CACHE:-}"
test "$(umask)" = "$EXPECTED_UMASK"
test -d "$NODE_COMPILE_CACHE" && test ! -L "$NODE_COMPILE_CACHE"
test "$(stat -c %u "$NODE_COMPILE_CACHE")" = "$(id -u)"
test "$(stat -c %a "$NODE_COMPILE_CACHE")" = 700
printf '%s\\0' "$NODE_COMPILE_CACHE" "$@" >> "$RECEIPT"
# An actual grandchild inherits the phase-local variable, as hook/core children do.
/bin/bash -c 'test -d "$NODE_COMPILE_CACHE"; test "$(umask)" = "$EXPECTED_UMASK"; printf "%s" "$NODE_COMPILE_CACHE" > "$CHILD_RECEIPT"'
printf 'cache bytes' > "$NODE_COMPILE_CACHE/probe"
exit "$NODE_EXIT"
`);
  chmodSync(join(bin, 'node'), 0o700);
  return { root, home, bin, receipt: join(root, 'receipt'), child: join(root, 'child') };
}

function invoke(w, code = 0, twice = false, mask = '0022') {
  return spawnSync('/bin/bash', ['-euo', 'pipefail', '-c', `umask ${mask}\n${block}\n${twice ? block : ''}\ntest -z "\${NODE_COMPILE_CACHE:-}"\ntest "$(umask)" = "${mask}"`], {
    encoding: 'utf8', timeout: 10_000,
    env: { PATH: `${w.bin}:/usr/bin:/bin`, HOME: w.home, RECEIPT: w.receipt, CHILD_RECEIPT: w.child, NODE_EXIT: String(code), EXPECTED_UMASK: mask },
  });
}

test('CI keeps full Node arguments, private child inheritance and no phase/cache leakage', () => {
  const w = world();
  try {
    const beforeMode = statSync(w.home).mode;
    const result = invoke(w, 0, true);
    assert.equal(result.status, 0, result.stderr);
    const values = readFileSync(w.receipt, 'utf8').split('\0').slice(0, -1);
    assert.equal(values.length, 2 * (args.length + 1));
    const first = values[0], second = values[args.length + 1];
    assert.notEqual(first, second, 'separate invocations never reuse a cache');
    for (const path of [first, second]) {
      assert.equal(path.startsWith(join(w.home, 'ce-node-compile-cache.')), true);
      assert.equal(existsSync(path), false, 'normal phase exit removes populated cache');
    }
    assert.deepEqual(values.slice(1, args.length + 1), args);
    assert.deepEqual(values.slice(args.length + 2), args);
    assert.equal(readFileSync(w.child, 'utf8'), second);
    assert.deepEqual(readdirSync(w.home), []);
    assert.equal(statSync(w.home).mode, beforeMode);
  } finally { rmSync(w.root, { recursive: true, force: true }); }
});

test('cache creation preserves the caller umask in Node and its children', () => {
  for (const mask of ['0022', '0027']) {
    const w = world();
    try {
      const result = invoke(w, 0, false, mask);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(readdirSync(w.home), []);
    } finally { rmSync(w.root, { recursive: true, force: true }); }
  }
});

test('a failed Node phase preserves its exit and removes its populated cache', () => {
  const w = world();
  try {
    const result = invoke(w, 23);
    assert.equal(result.status, 23, result.stderr);
    const cache = readFileSync(w.receipt, 'utf8').split('\0')[0];
    assert.equal(existsSync(cache), false);
    assert.deepEqual(readdirSync(w.home), []);
  } finally { rmSync(w.root, { recursive: true, force: true }); }
});

test('cache creation failure stops before any Node test command', () => {
  const w = world();
  try {
    writeFileSync(join(w.bin, 'mktemp'), '#!/bin/bash\nexit 17\n');
    chmodSync(join(w.bin, 'mktemp'), 0o700);
    const result = invoke(w);
    assert.equal(result.status, 17, result.stderr);
    assert.equal(existsSync(w.receipt), false);
    assert.deepEqual(readdirSync(w.home), []);
  } finally { rmSync(w.root, { recursive: true, force: true }); }
});

test('cleanup failure fails a passing phase and preserves an already failed Node exit', () => {
  for (const code of [0, 23]) {
    const w = world();
    try {
      writeFileSync(join(w.bin, 'rm'), '#!/bin/bash\nexit 19\n');
      chmodSync(join(w.bin, 'rm'), 0o700);
      const result = invoke(w, code);
      assert.equal(result.status, code || 1, result.stderr);
      const cache = readFileSync(w.receipt, 'utf8').split('\0')[0];
      assert.equal(existsSync(cache), true, 'failed removal must not report successful CI');
    } finally { rmSync(w.root, { recursive: true, force: true }); }
  }
});

test('cache scope follows all manager/Python/typecheck work and ends before native export', () => {
  const start = source.indexOf(block);
  for (const command of ['pnpm --dir "$runtime" install', 'python3 -I -B setup/ci/validate-pnpm-archive.test.py', 'node node_modules/typescript/bin/tsc']) {
    const before = source.indexOf(command);
    assert.ok(before >= 0 && before < start, command);
  }
  assert.ok(start + block.length < source.indexOf('binary="$runtime/node_modules/'));
  assert.equal([...source.matchAll(/NODE_COMPILE_CACHE=/g)].length, 1);
  assert.doesNotMatch(source, /export NODE_COMPILE_CACHE|NODE_DISABLE_COMPILE_CACHE|--test-name-pattern|--test-skip-pattern/);
});
