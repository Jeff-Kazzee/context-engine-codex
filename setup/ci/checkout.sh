#!/usr/bin/env bash
set -euo pipefail
set +x

refuse() { printf 'CI_NATIVE_CHECKOUT_REFUSED: %s\n' "$1" >&2; exit 1; }

# This first native step must not invoke a JavaScript action or package manager.
test "${RUNNER_ENVIRONMENT:-}" = github-hosted || refuse 'Require a GitHub-hosted runner.'
test "${RUNNER_OS:-}" = Linux || refuse 'Require native Linux.'
test "${RUNNER_ARCH:-}" = X64 || refuse 'Require X64 architecture.'
test "${GITHUB_SERVER_URL:-}" = https://github.com || refuse 'Require github.com.'
test "${GITHUB_REPOSITORY:-}" = Jeff-Kazzee/context-engine-codex || refuse 'Require the reviewed CE repository.'
[[ "${EXPECTED_SHA:-}" =~ ^[a-f0-9]{40}$ ]] || refuse 'Require an exact source SHA.'
test -z "${ACTIONS_RUNNER_HOOK_JOB_STARTED:-}${ACTIONS_RUNNER_HOOK_JOB_COMPLETED:-}" || refuse 'Unreviewed runner hooks are configured.'
grep --quiet --fixed-strings 'VERSION_ID="24.04"' /etc/os-release || refuse 'Require Ubuntu 24.04.'
ca_version=$(dpkg-query --show --showformat='${Version}' ca-certificates) || refuse 'Cannot read the native CA package version.'
printf 'Native checkout CA package: %s\n' "$ca_version"
dpkg --compare-versions "$ca_version" ge 20260816ubuntu0.24.04.1 || refuse 'Native CA package is below the reviewed 20260816ubuntu0.24.04.1 floor.'
test -z "${GIT_SSL_NO_VERIFY:-}${GIT_SSL_CAINFO:-}${CURL_CA_BUNDLE:-}${SSL_CERT_FILE:-}${SSL_CERT_DIR:-}" || refuse 'Unreviewed TLS overrides are configured.'
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
: "${GITHUB_WORKSPACE:?The hosted workspace is required.}"
: "${CI_CHECKOUT_TOKEN:?The scoped workflow token is required.}"
cd -- "$GITHUB_WORKSPACE"
test -z "$(find . -mindepth 1 -maxdepth 1 -print -quit)" || refuse 'Require an empty checkout directory.'

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
