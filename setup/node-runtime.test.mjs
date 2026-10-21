import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { assertSupportedNode } from './node-runtime.mjs';

const guard = fileURLToPath(new URL('./check-node.mjs', import.meta.url));
const cli = fileURLToPath(new URL('../core/cli.ts', import.meta.url));

for (const version of ['24.22.1', '24.22.2', '24.23.0', '26.12.1', '26.12.2', '26.13.0']) {
  test(`supported security release ${version}`, () => assert.doesNotThrow(() => assertSupportedNode(version)));
}

for (const version of ['18.20.8', '20.20.0', '22.23.3', '22.23.4', '23.11.0', '24.0.0', '24.19.0', '24.21.0', '24.22.0', '25.5.0', '26.0.0', '26.11.1', '26.12.0', '27.0.0', '28.0.0']) {
  test(`refuse unsupported or affected release ${version}`, () => {
    assert.throws(() => assertSupportedNode(version), { code: 'CE_UNSUPPORTED_NODE' });
  });
}

for (const version of ['', 'v24.22.1', '24.22', '024.22.1', '24.022.1', '24.22.01', '24.22.1\n', '24.22.1-rc.1', '24.21.0-cua.2', '24.22.1+custom', '24.9007199254740992.1', null, 24, {}]) {
  test(`refuse malformed or unapproved build ${JSON.stringify(version)}`, () => {
    assert.throws(() => assertSupportedNode(version), { code: 'CE_UNSUPPORTED_NODE' });
  });
}

test('entry point checks the actual running version', () => {
  const result = spawnSync(process.execPath, [guard], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`Node\\.js ${process.versions.node.replaceAll('.', '\\.')}.*supported`));
});

// These isolated children simulate version metadata on the fixed test runtime.
// They never start an affected Node binary or change the parent runtime.
function simulatedVersion(version) {
  return `data:text/javascript,${encodeURIComponent(`Object.defineProperty(process.versions, 'node', { value: ${JSON.stringify(version)} });`)}`;
}

test('an affected actual version cannot be overridden by a passing argument', () => {
  const result = spawnSync(process.execPath, ['--import', simulatedVersion('24.21.0'), guard, '24.22.1'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /CE_UNSUPPORTED_NODE.*24\.21\.0/);
});

test('setup refuses an affected version before creating state', () => {
  assert.ok(existsSync(cli), 'run this integration control in the repository');
  const root = mkdtempSync(join(tmpdir(), 'ce-node-refusal-'));
  try {
    const result = spawnSync(process.execPath, ['--import', simulatedVersion('24.21.0'), cli, 'install'], {
      cwd: root, encoding: 'utf8', timeout: 10000,
      env: { ...process.env, HOME: root, USERPROFILE: root, CODEX_HOME: join(root, 'codex'), CLAUDE_CONFIG_DIR: join(root, 'claude'), CONTEXT_ENGINE_STATE_DIR: join(root, 'state') },
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /CE_UNSUPPORTED_NODE.*24\.21\.0/);
    assert.match(result.stderr, /^CE_UNSUPPORTED_NODE: [^\r\n]+\r?\n$/);
    assert.deepEqual(readdirSync(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const entry of ['install', 'installLocked']) {
  test(`programmatic ${entry} refuses an affected version before using setup paths`, () => {
    const target = new URL('./install.ts', import.meta.url).href;
    const script = `const module = await import(${JSON.stringify(target)}); module.${entry}();`;
    const result = spawnSync(process.execPath, ['--import', simulatedVersion('24.21.0'), '--input-type=module', '--eval', script], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /CE_UNSUPPORTED_NODE.*24\.21\.0/);
    assert.doesNotMatch(result.stderr, /Cannot read properties of undefined/);
  });
}

test('ordinary package commands require the runtime guard', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  for (const name of ['test', 'typecheck', 'preinstall']) {
    assert.match(pkg.scripts[name], /^node setup\/check-node\.mjs(?: && |$)/, name);
  }
  if (pkg.scripts['test:claude-plugins']) {
    assert.match(pkg.scripts['test:claude-plugins'], /^node setup\/check-node\.mjs && /);
  }
  assert.equal(pkg.engines.node, '>=24.22.1 <25 || >=26.12.1 <27');
});

test('CI gates precede dependency execution and cannot ignore failure', () => {
  const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
  const guardStep = '      - name: Refuse unsupported or affected Node runtimes\n        run: node setup/check-node.mjs\n';
  const auditStep = '      - name: Audit all locked dependencies before installation\n        run: pnpm audit --audit-level=low\n';
  assert.ok(workflow.includes(guardStep));
  assert.ok(workflow.includes(auditStep));
  assert.ok(workflow.indexOf(guardStep) < workflow.indexOf('run: pnpm import'));
  assert.ok(workflow.indexOf('- name: Hold unverified package manager bootstrap') < workflow.indexOf('uses: actions/setup-node@'));
  assert.ok(workflow.indexOf(auditStep) < workflow.indexOf('pnpm install --frozen-lockfile --ignore-scripts'));
  const nativeAudit = workflow.indexOf('pnpm --dir "$runtime" audit --audit-level=low');
  assert.ok(nativeAudit > 0 && nativeAudit < workflow.indexOf('pnpm --dir "$runtime" install'));
  assert.doesNotMatch(workflow, /continue-on-error|always\(\)|audit[^\n]*(?:\|\||--prod|--production)/);
  assert.match(workflow, /permissions:\n  contents: read/);
  assert.match(workflow, /node-version: '24\.22\.1'/);
});
