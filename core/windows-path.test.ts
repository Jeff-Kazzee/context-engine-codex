import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertWindowsComponent } from './windows-path.ts';

test('Windows path policy rejects aliases, devices, alternate streams and traversal', () => {
  for (const name of ['', '.', '..', 'CON', 'Con.txt', 'NUL', 'COM1', 'Lpt9.log', 'COM\u00b9', 'LPT\u00b2', 'LPT\u00b3', 'CONIN$', 'a.', 'a ', 'a:b', 'a/b', 'a\\b', 'a\0b', 'x'.repeat(256)]) {
    assert.throws(() => assertWindowsComponent(name), { code: 'EINVAL' }, name);
  }
});
test('ordinary Windows components retain exact spelling', () => {
  for (const name of ['context.md', '.context-engine', '.gitignore', 'S1', 'évidence', 'x'.repeat(255)]) assert.doesNotThrow(() => assertWindowsComponent(name));
});
