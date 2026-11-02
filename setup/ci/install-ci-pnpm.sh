#!/usr/bin/env bash
set -euo pipefail

# Only the CI runner's temporary directory and per-job PATH are changed.
node /opt/ce/check-node.mjs
node /opt/ce/ci/check-pnpm.mjs --pin
: "${RUNNER_TEMP:?The CI runner temporary directory is required.}"
: "${GITHUB_PATH:?The CI per-job PATH file is required.}"

workdir=$(mktemp -d "${RUNNER_TEMP%/}/verified-pnpm.XXXXXXXX")
archive="$workdir/pnpm.tgz"
destination="$workdir/unpacked"
url='https://registry.npmjs.org/pnpm/-/pnpm-11.28.6.tgz'
sha512='55d90390c3b39042f1505a2697789f0256c6d95bb28bdd7cb731af1887c9f2629ef581acb9f4e4ec772024c8203c2aed22a03299b97103fdcf32668e905d0024'

# Signature and OIDC evidence for this exact digest was verified on 2026-10-21.
curl --fail --silent --show-error --proto '=https' --proto-redir '=https' \
  --connect-timeout 15 --max-time 90 --max-filesize 8388608 \
  --output "$archive" "$url"
printf '%s  %s\n' "$sha512" "$archive" | sha512sum --check --status
python3 -I -B /opt/ce/ci/validate-pnpm-archive.py "$archive"
mkdir -- "$destination" "$workdir/bin"
tar --extract --gzip --file "$archive" --directory "$destination" \
  --no-same-owner --no-same-permissions --keep-old-files
test -x "$destination/package/bin/pnpm.mjs"
ln -s ../unpacked/package/bin/pnpm.mjs "$workdir/bin/pnpm"
ln -s ../unpacked/package/bin/pnpx.mjs "$workdir/bin/pnpx"
printf '%s\n' "$workdir/bin" >> "$GITHUB_PATH"
