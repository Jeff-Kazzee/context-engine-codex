import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export function inputError(root, policy, read = readFileSync, stat = lstatSync) {
  for (const [name, expected] of Object.entries(policy.inputs)) {
    if (!stat(join(root, name)).isFile()) return `Require a regular CI input: ${name}`;
    const text = read(join(root, name), 'utf8').replaceAll('\r\n', '\n');
    if (createHash('sha256').update(text).digest('hex') !== expected) return `Unreviewed CI input: ${name}`;
  }
  for (let cursor = root; ; cursor = dirname(cursor)) {
    for (const name of ['pnpm-workspace.yaml', 'pnpm-workspace.yml', '.npmrc', '.pnpmfile.mjs', '.pnpmfile.cjs', 'pnpmfile.mjs', 'pnpmfile.cjs', 'yarn.lock', '.yarnrc', '.yarnrc.yml', 'npm-shrinkwrap.json', 'package.yaml', 'package.json5', 'bun.lock', 'bun.lockb']) {
      try { stat(join(cursor, name)); return `Unreviewed manager configuration: ${name}`; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (dirname(cursor) === cursor) break;
  }
  return null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const policy = JSON.parse(readFileSync(new URL('./policy.json', import.meta.url), 'utf8'));
  if (process.cwd() !== '/ce-runner-temp/project') throw new Error('Require the reviewed container workspace.');
  for (const name of ['pnpm-lock.yaml', 'pnpm-lock.yml']) {
    try { lstatSync(name); throw new Error('Refuse a preexisting generated pnpm lock.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const error = inputError(process.cwd(), policy);
  if (error) throw new Error(error);
}
