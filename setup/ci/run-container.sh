#!/usr/bin/env bash
set -euo pipefail
test "$#" = 0
test "${RUNNER_ENVIRONMENT:-}" = github-hosted
test "${RUNNER_OS:-}" = Linux
test "${RUNNER_ARCH:-}" = X64
[[ "${EXPECTED_HEAD:-}" =~ ^[a-f0-9]{40}$ ]]
test "$(git rev-parse HEAD)" = "$EXPECTED_HEAD"
uid=$(id -u)
gid=$(id -g)
[[ "$uid" =~ ^[1-9][0-9]*$ && "$gid" =~ ^[1-9][0-9]*$ ]]
workspace=$(realpath -e -- "${GITHUB_WORKSPACE:?}")
temporary=$(realpath -e -- "${RUNNER_TEMP:?}")
case "$workspace$temporary" in *','*|*$'\n'*) echo 'Unsupported bind path.' >&2; exit 1;; esac
data=$(mktemp -d "$temporary/ce-container-data.XXXXXXXX")
: "${GITHUB_ENV:?The per-job environment file is required.}"
printf 'CE_CONTAINER_DATA=%s\n' "$data" >> "$GITHUB_ENV"
image="ce-fixed-runtime:$EXPECTED_HEAD"
docker build --pull --build-arg "CE_UID=$uid" --build-arg "CE_GID=$gid" \
  --tag "$image" --file .github/actions/security-ci/Dockerfile .
# Only these two data mounts enter the non-root workload. No Docker socket is mounted.
docker run --rm --init --read-only --cap-drop=ALL --security-opt=no-new-privileges \
  --pids-limit=512 --user "$uid:$gid" \
  --tmpfs /tmp:rw,nosuid,nodev,mode=1777 \
  --mount "type=bind,source=$workspace,target=/github/workspace,readonly" \
  --mount "type=bind,source=$data,target=/ce-runner-temp" \
  --workdir /github/workspace \
  --env RUNNER_OS=Linux --env RUNNER_ARCH=X64 --env RUNNER_TEMP=/ce-runner-temp \
  --env "EXPECTED_HEAD=$EXPECTED_HEAD" --env "GITHUB_REPOSITORY=$GITHUB_REPOSITORY" \
  "$image"
