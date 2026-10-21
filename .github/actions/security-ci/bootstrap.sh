#!/usr/bin/env bash
set -euo pipefail
workdir=$(mktemp -d /tmp/ce-runtime.XXXXXXXX)
trap 'rm -rf -- "$workdir"' EXIT

# Downloads are fixed public artifacts. No fetched installer or package manager runs.
python3 -I -S -B - /opt/ce/artifacts.json "$workdir" <<'PY'
import hashlib
import json
from pathlib import Path
import sys
import tarfile
import urllib.request

manifest = json.loads(Path(sys.argv[1]).read_text())
temporary = Path(sys.argv[2])
for item in manifest['artifacts']:
    digest = item['sha256']
    if len(digest) != 64 or any(c not in '0123456789abcdef' for c in digest):
        raise SystemExit('Artifact authentication is not finalized.')
    url = item['url']
    if not url == 'https://nodejs.org/dist/v24.22.1/node-v24.22.1-linux-x64.tar.xz':
        raise SystemExit('Unreviewed artifact origin.')
    request = urllib.request.Request(url, headers={'User-Agent': 'ce-fixed-runtime-ci'})
    with urllib.request.urlopen(request, timeout=60) as response:
        if response.url != url:
            raise SystemExit('Unexpected artifact redirect.')
        data = response.read(item['maxBytes'] + 1)
    if len(data) > item['maxBytes'] or hashlib.sha256(data).hexdigest() != digest:
        raise SystemExit('Artifact exceeds its bound or fails authentication.')
    destination = Path(item['destination'])
    if str(destination) != '/opt/node/bin/node':
        raise SystemExit('Unreviewed artifact destination.')
    destination.parent.mkdir(parents=True, exist_ok=True)
    if item.get('member'):
        archive = temporary / 'node.tar.xz'
        archive.write_bytes(data)
        with tarfile.open(archive, mode='r:xz') as source:
            matches = [m for m in source.getmembers() if m.name == item['member']]
            if len(matches) != 1 or not matches[0].isreg() or matches[0].size > 150 * 1024 * 1024:
                raise SystemExit('Expected one regular bounded Node executable.')
            node = source.extractfile(matches[0]).read()
        destination.write_bytes(node)
        destination.chmod(0o755)
    else:
        destination.write_bytes(data)
PY

# This is the only Node binary in the image. npm, Corepack and Yarn are not extracted.
test "$(/opt/node/bin/node --version)" = v24.22.1
test ! -e /opt/node/bin/npm
test ! -e /opt/node/bin/corepack
test ! -e /opt/node/bin/yarn
dpkg-query --show --showformat='${Package} ${Version}\n' ca-certificates curl python3 xz-utils git
/opt/node/bin/node -p 'JSON.stringify({node:process.versions.node,openssl:process.versions.openssl,execPath:process.execPath})'
