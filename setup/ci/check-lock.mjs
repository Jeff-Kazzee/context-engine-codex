import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

// Admit only the reviewed registry-only v9 lock shape; PNPM remains its parser.
export function lockError(text, expected) {
  if (Buffer.byteLength(text) > 256 * 1024 || !/^lockfileVersion: '9\.0'\r?$/m.test(text)) return 'Unreviewed generated lock schema or size.';
  if (/\b(?:file|link|workspace|portal|patch|git\+https|https?):|(?:^|\s)[&*][A-Za-z]|!<|!!/.test(text)) return 'Unreviewed lock source or YAML feature.';
  const section = text.split(/^packages:\r?$/m)[1]?.split(/^[A-Za-z][A-Za-z0-9]*:\r?$/m)[0];
  if (!section) return 'Missing generated package records.';
  const headers = [...section.matchAll(/^  (?:'([^']+)'|([^\s:]+)):\r?$/gm)];
  if (headers.length !== Object.keys(expected).length) return 'Unexpected generated package count.';
  const seen = new Set();
  for (let i = 0; i < headers.length; i++) {
    const key = headers[i][1] || headers[i][2];
    if (!Object.hasOwn(expected, key) || seen.has(key)) return 'Unexpected generated package identity.';
    seen.add(key);
    const block = section.slice(headers[i].index, headers[i + 1]?.index);
    const hashes = [...block.matchAll(/\bintegrity:\s*(sha512-[A-Za-z0-9+/]{86}==)/g)];
    if (hashes.length !== 1 || (expected[key] !== null && hashes[0][1] !== expected[key])) return 'Unexpected generated package integrity.';
  }
  return null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, directory, receipt] = process.argv.slice(2);
  if (!['root', 'native', 'verify'].includes(mode) || !directory || !receipt || process.argv.length !== 5) throw new Error('Require lock mode, directory and private receipt.');
  const bytes = readFileSync(directory + '/pnpm-lock.yaml');
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (mode === 'verify') {
    if (readFileSync(receipt, 'utf8') !== digest) throw new Error('Generated pnpm lock changed after validation.');
  } else {
    let expected;
    if (mode === 'root') {
      const npm = JSON.parse(readFileSync(directory + '/package-lock.json', 'utf8'));
      expected = Object.fromEntries(Object.entries(npm.packages).filter(([path]) => path).map(([path, item]) => [path.slice('node_modules/'.length) + '@' + item.version, item.integrity]));
    } else {
      const manifest = JSON.parse(readFileSync(directory + '/package.json', 'utf8'));
      if (!['Jeff-Kazzee/context-engine-codex', 'Jeff-Kazzee/context-engine-claude'].includes(process.env.GITHUB_REPOSITORY)) throw new Error('Require a reviewed CE repository.');
      const packageName = process.env.GITHUB_REPOSITORY === 'Jeff-Kazzee/context-engine-codex' ? '@openai/codex' : '@anthropic-ai/claude-code-linux-x64';
      const version = packageName === '@openai/codex' ? '0.161.0-linux-x64' : '2.1.289';
      if (JSON.stringify(manifest) !== JSON.stringify({ private: true, dependencies: { [packageName]: version } })) throw new Error('Unreviewed native-package manifest.');
      expected = { [packageName + '@' + version]: null };
    }
    const error = lockError(bytes.toString('utf8'), expected);
    if (error) throw new Error(error);
    writeFileSync(receipt, digest, { flag: 'wx', mode: 0o600 });
  }
}
