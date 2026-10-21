#!/usr/bin/env bash
set -euo pipefail
test "$(id -u)" != 0
test "${RUNNER_OS:-}" = Linux
test "${RUNNER_ARCH:-}" = X64
test -z "${NODE_OPTIONS:-}${NODE_EXTRA_CA_CERTS:-}${NODE_TLS_REJECT_UNAUTHORIZED:-}"
cd -- /github/workspace
# The native Docker driver binds only job data and selects the checkout identity.
test "$(id -u)" = "$(stat -c %u .)"
test "$(id -g)" = "$(stat -c %g .)"
: "${RUNNER_TEMP:?The translated per-job temporary directory is required.}"
build_root="$RUNNER_TEMP/project"
mkdir --mode=700 -- "$build_root"
cp -a --no-preserve=ownership -- /github/workspace/. "$build_root/"
private_home=$(mktemp -d "${RUNNER_TEMP%/}/ce-container-home.XXXXXXXX")
mkdir --mode=700 -- "$private_home/tmp"
exec env -i \
  PATH=/opt/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  HOME="$private_home" TMPDIR="$private_home/tmp" XDG_CONFIG_HOME="$private_home/config" \
  RUNNER_TEMP="$RUNNER_TEMP" EXPECTED_HEAD="${EXPECTED_HEAD:?}" \
  GITHUB_REPOSITORY="${GITHUB_REPOSITORY:?}" GITHUB_WORKSPACE="$build_root" \
  CONTEXT_ENGINE_REAL_CODEX_TESTS=0 CE_CONTAINER_CI=1 CI=1 NODE_USE_SYSTEM_CA=1 \
  NPM_CONFIG_USERCONFIG=/dev/null NPM_CONFIG_GLOBALCONFIG=/dev/null \
  PNPM_CONFIG_MANAGE_PACKAGE_MANAGER_VERSIONS=false PNPM_CONFIG_IGNORE_PNPMFILE=true PNPM_CONFIG_IGNORE_SCRIPTS=true \
  /bin/bash /opt/ce/run.sh
