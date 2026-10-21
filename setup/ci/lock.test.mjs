import assert from 'node:assert/strict';
import test from 'node:test';
import { lockError } from './check-lock.mjs';

test('only reviewed registry identities and integrity enter the generated lock', () => {
  const integrity = 'sha512-' + Buffer.alloc(64).toString('base64');
  const text = `lockfileVersion: '9.0'\npackages:\n  '@types/node@24.19.1':\n    resolution: {integrity: ${integrity}}\nsnapshots:\n  '@types/node@24.19.1': {}\n`;
  const expected = { '@types/node@24.19.1': integrity };
  assert.equal(lockError(text, expected), null);
  for (const changed of [text.replace('9.0', '10.0'), text.replaceAll('@24.19.1', '@24.19.0'), text.replace(integrity, 'sha512-ZGVm'), text.replace('packages:', 'other:'), text + 'tarball: https://unreviewed.invalid/a\n', text + 'unreviewed: &anchor\n', text + 'source: file:../x\n']) {
    assert.ok(lockError(changed, expected));
  }
});
