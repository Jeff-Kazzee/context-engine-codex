#!/usr/bin/env bash
set -euo pipefail
set +x

# This first native step must not invoke a JavaScript action or package manager.
test "${RUNNER_ENVIRONMENT:-}" = github-hosted
test "${RUNNER_OS:-}" = Linux
test "${RUNNER_ARCH:-}" = X64
test "${GITHUB_SERVER_URL:-}" = https://github.com
test "${GITHUB_REPOSITORY:-}" = Jeff-Kazzee/context-engine-codex
[[ "${EXPECTED_SHA:-}" =~ ^[a-f0-9]{40}$ ]]
test -z "${ACTIONS_RUNNER_HOOK_JOB_STARTED:-}${ACTIONS_RUNNER_HOOK_JOB_COMPLETED:-}"
grep --quiet --fixed-strings 'VERSION_ID="24.04"' /etc/os-release
ca_version=$(dpkg-query --show --showformat='${Version}' ca-certificates)
dpkg --compare-versions "$ca_version" ge 20260816ubuntu0.24.04.1
printf 'Native checkout CA package: %s\n' "$ca_version"
test -z "${GIT_SSL_NO_VERIFY:-}${GIT_SSL_CAINFO:-}${CURL_CA_BUNDLE:-}${SSL_CERT_FILE:-}${SSL_CERT_DIR:-}"
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
: "${GITHUB_WORKSPACE:?The hosted workspace is required.}"
: "${CI_CHECKOUT_TOKEN:?The scoped workflow token is required.}"
cd -- "$GITHUB_WORKSPACE"
test -z "$(find . -mindepth 1 -maxdepth 1 -print -quit)"

# Never persist credentials in the remote URL, repository config or a helper.
auth=$(printf 'x-access-token:%s' "$CI_CHECKOUT_TOKEN" | base64 -w 0)
printf '::add-mask::%s\n' "$auth"
trap 'unset CI_CHECKOUT_TOKEN auth' EXIT
git -c init.templateDir= init --quiet .
git remote add origin https://github.com/Jeff-Kazzee/context-engine-codex.git
GIT_CONFIG_COUNT=1 \
GIT_CONFIG_KEY_0=http.https://github.com/.extraheader \
GIT_CONFIG_VALUE_0="AUTHORIZATION: basic $auth" \
git -c credential.helper= -c core.hooksPath=/dev/null -c protocol.file.allow=never \
  fetch --quiet --no-tags --depth=1 --no-recurse-submodules origin "$EXPECTED_SHA"
unset CI_CHECKOUT_TOKEN auth
git -c core.hooksPath=/dev/null checkout --quiet --detach FETCH_HEAD
test "$(git rev-parse HEAD)" = "$EXPECTED_SHA"
printf 'Checked out exact event commit %s without persistent credentials.\n' "$EXPECTED_SHA"
