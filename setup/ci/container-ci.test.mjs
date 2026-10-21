import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const read = path => readFileSync(new URL('../../' + path, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const workflow = read('.github/workflows/ci.yml');
const linux = workflow.split('\n  linux:\n')[1];
const driver = read('setup/ci/run-container.sh');
const docker = read('.github/actions/security-ci/Dockerfile');
const bootstrap = read('.github/actions/security-ci/bootstrap.sh');
const entry = read('.github/actions/security-ci/entrypoint.sh');
const run = read('.github/actions/security-ci/run.sh');
const native = read('setup/ci/native-contract.sh');
const artifact = JSON.parse(read('.github/actions/security-ci/artifacts.json'));

function validateLinux(source) {
  assert.ok(source);
  assert.equal(/^\s+uses:/m.test(source), false);
  assert.ok(source.includes('run: bash setup/ci/run-container.sh'));
  assert.equal(/hashFiles\s*\(|continue-on-error|always\(\)|failure\(\)|\b(?:setup-node|checkout)@/.test(source), false);
  assert.equal(/privileged|cap-add|docker\.sock|id-token:|contents: write/.test(source), false);
  assert.match(source, /steps:\n      - name: Native checkout of the exact event commit\n/);
  assert.doesNotMatch(source, /CI_CE_ARTIFACT_APPROVAL_REQUIRED/);
}

test('Linux uses only native checkout and the approved native Docker driver', () => {
  validateLinux(linux);
  assert.equal(existsSync(new URL('../../.github/actions/security-ci/action.yml', import.meta.url)), false);
  for (const mutation of [linux.replace('run: bash setup/ci/run-container.sh', 'uses: actions/checkout@bad'), linux.replace('Native checkout of the exact event commit', 'Skipped native checkout'), linux + '\n    if: always()']) {
    assert.throws(() => validateLinux(mutation));
  }
  assert.match(workflow, /permissions:\n  contents: read/);
  assert.match(workflow, /os: windows-2022\n\s+coverage: Windows pure operations and refusal/);
  assert.match(workflow, /os: macos-15\n\s+coverage: macOS pure operations and refusal/);
  assert.match(linux, /name: Linux maintained suite/);
});

test('native checkout is bound to the exact event SHA and reviewed source', () => {
  const source = read('setup/ci/checkout.sh').trimEnd();
  const marker = '        run: |\n          #!/usr/bin/env bash\n';
  const start = linux.indexOf(marker);
  const end = linux.indexOf('\n      - name:', start + marker.length);
  const body = linux.slice(start + '        run: |\n'.length, end).split('\n').map(line => line.slice(10)).join('\n').trimEnd();
  assert.equal(body, source);
  assert.ok(source.indexOf("printf 'Native checkout CA package:") < source.indexOf('dpkg --compare-versions'));
  assert.ok(source.includes('CI_NATIVE_CHECKOUT_REFUSED:'));
  assert.match(linux, /EXPECTED_SHA: \$\{\{ github.event.pull_request.head.sha \|\| github.sha \}\}/);
  for (const token of ['CI_CHECKOUT_TOKEN', '::add-mask::', 'GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null', 'credential.helper=', 'core.hooksPath=/dev/null', '--no-recurse-submodules', 'unset CI_CHECKOUT_TOKEN auth', 'git rev-parse HEAD']) assert.ok(source.includes(token), token);
  assert.equal(/git config|github_pat_|ghp_|authorization:.*\$\{\{/i.test(source), false);
});

test('the image and approved test-only Node artifact remain pinned', () => {
  assert.ok(docker.includes('ubuntu@sha256:33ceb71981b602c1a7443a53469e4dba065f7503eab3078a2d7a57a2ab987517'));
  assert.ok(docker.includes('ca-certificates=20260816ubuntu0.24.04.1'));
  assert.equal(artifact.artifacts.length, 1);
  assert.equal(artifact.artifacts[0].sha256, '6c172a9ab6718f7b801fb5a7bd486af2ee5e32758086a04b84fcce2aa77095e6');
  assert.equal(artifact.artifacts[0].destination, '/opt/node/bin/node');
  assert.equal(artifact.artifacts[0].member, 'node-v24.22.1-linux-x64/bin/node');
  assert.equal(artifact.nodeAuthentication.buildProvenanceVerified, false);
  assert.equal(artifact.ceException.status, 'approved');
  assert.equal(artifact.ceException.testOnly, true);
  assert.deepEqual(artifact.ceException.repositories, ['Jeff-Kazzee/context-engine-codex', 'Jeff-Kazzee/context-engine-claude']);
  assert.equal(artifact.ceException.approvedOnUtc, '2026-10-21');
  assert.ok(bootstrap.indexOf('hashlib.sha256(data).hexdigest() != digest') < bootstrap.indexOf('with tarfile.open'));
  assert.ok(bootstrap.includes('response.url != url'));
  assert.match(bootstrap, /test ! -e \/opt\/node\/bin\/npm/);
  assert.match(bootstrap, /test ! -e \/opt\/node\/bin\/corepack/);
});

test('non-root tests and the separate host network isolation remain required', () => {
  assert.match(entry, /test "\$\(id -u\)" = "\$\(stat -c %u \.\)"/);
  assert.match(entry, /exec env -i/);
  assert.match(driver, /--read-only --cap-drop=ALL --security-opt=no-new-privileges/);
  assert.match(driver, /--pids-limit=512 --user "\$uid:\$gid"/);
  assert.deepEqual([...driver.matchAll(/--mount "([^"]+)"/g)].map(match => match[1]), ['type=bind,source=$workspace,target=/github/workspace,readonly', 'type=bind,source=$data,target=/ce-runner-temp']);
  assert.match(driver, /data=\$\(mktemp -d "\$temporary\/ce-container-data\.XXXXXXXX"\)/);
  assert.ok(docker.includes('COPY setup/ci/ /opt/ce/ci/'));
  assert.ok(docker.includes('setup/check-node.mjs setup/node-runtime.mjs /opt/ce/'));
  assert.match(entry, /cp -a --no-preserve=ownership -- \/github\/workspace\/\. "\$build_root\/"/);
  assert.equal(/--privileged|--cap-add|--mount [^\n]*docker\.sock|--volume/.test(driver), false);
  assert.match(entry, /CE_CONTAINER_CI=1/);
  assert.match(run, /test "\$\(id -u\)" != 0/);
  assert.match(run, /python3 -I -B -c 'import ctypes/);
  assert.match(run, /node --test --test-concurrency=1 "core\/\*\*\/\*\.test.ts" "setup\/\*\.test.ts"/);
  assert.match(native, /sudo -n unshare --net -- runuser --user/);
  assert.ok(native.includes('e32e2d16081cf644f88392934288086e7662529d0d43277c34f7aad2207cfafb'));
  assert.ok(linux.indexOf('run: bash setup/ci/run-container.sh') < linux.indexOf('run: bash setup/ci/native-contract.sh'));
});

test('fixed manager operations require input guards and both dependency audits', () => {
  assert.equal([...run.matchAll(/^run_maintained_suite$/gm)].length, 1);
  assert.ok(run.indexOf('node /opt/ce/ci/check-inputs.mjs') < run.indexOf('bash /opt/ce/ci/install-ci-pnpm.sh'));
  assert.match(entry, /PNPM_CONFIG_IGNORE_PNPMFILE=true PNPM_CONFIG_IGNORE_SCRIPTS=true/);
  assert.match(run, /pnpm import --ignore-workspace\n/);
  assert.doesNotMatch(run, /pnpm import[^\n]*(?:--ignore-pnpmfile|--ignore-scripts)/);
  assert.ok(run.indexOf('pnpm audit --audit-level=low') < run.indexOf('pnpm install --frozen-lockfile --ignore-scripts'));
  assert.ok(run.indexOf('pnpm --dir "$runtime" audit --audit-level=low') < run.indexOf('pnpm --dir "$runtime" install --frozen-lockfile --ignore-scripts'));
  const managerEnd = run.lastIndexOf('pnpm --dir "$runtime" install');
  for (const command of ['node --test', 'python3 -I -B setup/ci/validate-pnpm-archive.test.py', 'node node_modules/typescript/bin/tsc']) assert.ok(managerEnd < run.indexOf(command), command);
  assert.equal(/pnpm (?:run|exec|test|build)|--prod(?:uction)?|--privileged|--cap-add/.test(run), false);
  assert.match(run, /node node_modules\/typescript\/bin\/tsc --noEmit -p \./);
});
