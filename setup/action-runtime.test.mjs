import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

function nativeWorkflow() {
  return readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8').replaceAll('\r\n', '\n').split('\n  linux:')[0];
}

test('action interpreter policy, actual probe and collector fail closed', {
  skip: process.platform === 'linux' && process.env.CE_CONTAINER_CI === '1' && 'Docker uses no JavaScript actions; the PowerShell probe remains covered by native Windows/macOS checks.',
}, (t) => {
  const script = fileURLToPath(new URL('./action-runtime.test.ps1', import.meta.url));
  const result = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script], {
    encoding: 'utf8', timeout: 20000,
    env: { ...process.env, CE_TEST_NODE: process.execPath, CE_TEST_NODE_VERSION: process.versions.node },
  });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  assert.match(result.stdout, /Action runtime probe: \d+ checks passed; only fixed Node/);
  t.diagnostic(result.stdout.trim());
});

test('the first workflow step is the exact reviewed shell probe', () => {
  const workflow = nativeWorkflow();
  const source = readFileSync(new URL('./action-runtime.ps1', import.meta.url), 'utf8').replaceAll('\r\n', '\n').trimEnd();
  const prefix = '    steps:\n      - name: Verify bundled JavaScript action runtime\n        id: action-runtime\n        shell: pwsh\n        timeout-minutes: 2\n        run: |\n';
  const start = workflow.indexOf(prefix);
  assert.ok(start > 0, 'probe must be the first workflow step');
  const bodyStart = start + prefix.length;
  const end = workflow.indexOf('\n      - ', bodyStart);
  assert.ok(end > bodyStart);
  const body = workflow.slice(bodyStart, end).split('\n').map(line => line.slice(10)).join('\n').trimEnd();
  assert.equal(body, source, 'inline pre-checkout guard must match its tested source byte for byte');
  const executableWorkflow = workflow.split('\n').filter(line => !line.trimStart().startsWith('#')).join('\n');
  assert.doesNotMatch(executableWorkflow, /hashFiles\s*\(|continue-on-error|always\(\)|failure\(\)|^\s+container:|^\s+services:/m);
  assert.deepEqual([...workflow.matchAll(/^\s+uses: (.+)$/gm)].map(match => match[1]), [
    'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1',
    'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0',
  ], 'action changes need a fresh immutable-manifest runtime and pre-hook review');
});

test('unverified package-manager execution is explicitly blocked', () => {
  const workflow = nativeWorkflow();
  const hold = workflow.indexOf('name: Hold unverified package manager bootstrap');
  const refusal = workflow.indexOf("run: throw 'CI_UNVERIFIED_PACKAGE_MANAGER", hold);
  const dependency = workflow.indexOf('run: pnpm import');
  assert.ok(hold > 0 && refusal > hold && dependency > refusal);
  assert.ok(refusal < workflow.indexOf('uses: actions/checkout@'));
  assert.ok(refusal < workflow.indexOf('uses: actions/setup-node@'));
  assert.equal(/uses: pnpm\/action-setup|^\s+run:\s+(?:npm|corepack)\b/m.test(workflow), false, 'no unreviewed manager bootstrap');
});
