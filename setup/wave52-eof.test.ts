import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../core/testing.ts';
import { codexProjectSettings, TOML_MARKERS, TOML_TOP_MARKERS } from './project.ts';
import { appendBlock, prependBlock } from './rules.ts';
import { projectCodexToml } from '../adapters/codex/guidance.ts';

for (const newline of [false, true]) {
  test(`wave52: Codex status recognizes the final managed marker with newline=${newline}`, () => {
    const root = tempDir('codex-eof');
    mkdirSync(join(root, '.codex'));
    const config = join(root, '.codex', 'config.toml'), expected = projectCodexToml({ experiments: [] });
    let text = appendBlock(prependBlock('', expected.top, TOML_TOP_MARKERS), expected.table, TOML_MARKERS);
    text = text.trimEnd() + (newline ? '\n' : '');
    writeFileSync(config, text);
    assert.equal(codexProjectSettings(root, []), true);
    assert.equal(readFileSync(config, 'utf8'), text);
    writeFileSync(config, text.replace(TOML_MARKERS.end, TOML_MARKERS.end + '-unrelated'));
    assert.equal(codexProjectSettings(root, []), false);
  });
}
