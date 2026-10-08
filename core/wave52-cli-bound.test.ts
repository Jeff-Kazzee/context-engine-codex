import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture } from './testing.ts';

const cli = fileURLToPath(new URL('./cli.ts', import.meta.url));
for (const command of ['record', 'native-compaction']) {
  test(`wave52: ${command} stops reading at the raw JSON byte limit before creating state`, () => {
    const f = fixture();
    const preload = join(f.projectRoot, 'bounded-stdin.mjs');
    // Simulate an oversized input stream without allocating it in the test parent.
    writeFileSync(preload, `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';let total=0;const read=fs.readSync;fs.readSync=function(fd,buffer,offset,length,position){if(fd!==0)return read(fd,buffer,offset,length,position);const n=Math.min(length,64*1024*1024+1-total);if(n<=0)return 0;buffer.fill(32,offset,offset+n);total+=n;return n;};syncBuiltinESMExports();`);
    const result = spawnSync(process.execPath, ['--import', preload, cli, command, '--session', 'S1', '--project', f.projectRoot, '--runner', 'raw-bound', '--hard-limit', '10000'], { input: '[]', encoding: 'utf8', timeout: 15000, env: { ...process.env, CONTEXT_ENGINE_STATE_DIR: f.stateDir } });
    assert.equal(result.status, 1, result.stderr);
    assert.match(JSON.parse(result.stdout).error, /64 MiB JSON input limit/);
    assert.equal(existsSync(f.stateDir), false);
    assert.equal(existsSync(join(f.projectRoot, '.context-engine')), false);
  });
}

test('wave52: bounded JSON input preserves a valid multibyte event', () => {
  const f = fixture();
  const result = spawnSync(process.execPath, [cli, 'record', '--session', 'S1', '--project', f.projectRoot, '--runner', 'raw-bound', '--hard-limit', '10000'], { input: JSON.stringify([{ role: 'user', text: 'REQUIREMENT 😀 café' }]), encoding: 'utf8', timeout: 15000, env: { ...process.env, CONTEXT_ENGINE_STATE_DIR: f.stateDir } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(JSON.parse(result.stdout).workingContextText, /REQUIREMENT 😀 café/);
});
