import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// The exact 11.28.6 artifact and its identified bundle were reviewed on 2026-10-21.
// A direct pnpm advisory floor alone does not cover bundled dependencies.
// https://github.com/pnpm/pnpm/security/advisories/GHSA-c59q-g84q-2gj5
export function pnpmVersionError(version) {
  const match = typeof version === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  if (!match) return 'pnpm must report an exact stable version.';
  const [major] = match.slice(1).map(Number);
  if (major !== 11) return `pnpm ${version} is outside the reviewed 11.x release line.`;
  if (version !== '11.28.6') return `pnpm ${version} is outside the reviewed artifact version 11.28.6.`;
  return null;
}

export function pnpmPinError(manifest) {
  const match = typeof manifest?.packageManager === 'string' && /^pnpm@(.+)$/.exec(manifest.packageManager);
  if (!match) return 'packageManager must pin pnpm to an exact stable version.';
  const error = pnpmVersionError(match[1]);
  if (error) return error;
  if (manifest.devEngines?.packageManager !== undefined) return 'Remove the competing devEngines.packageManager override.';
  return null;
}

function runtimeVersion() {
  const result = spawnSync('pnpm', ['--version'], {
    encoding: 'utf8', timeout: 10000, maxBuffer: 4096,
    shell: process.platform === 'win32',
    env: {
      ...process.env,
      PNPM_CONFIG_MANAGE_PACKAGE_MANAGER_VERSIONS: 'false',
      PNPM_CONFIG_IGNORE_PNPMFILE: 'true',
      PNPM_CONFIG_IGNORE_WORKSPACE: 'true',
      PNPM_CONFIG_IGNORE_SCRIPTS: 'true',
    },
  });
  if (result.error || result.status !== 0) throw new Error('Cannot read the installed pnpm version.');
  return result.stdout.trim();
}

export function pnpmRuntimeError(manifest, readVersion = runtimeVersion) {
  const pinError = pnpmPinError(manifest);
  if (pinError) return pinError;
  let version;
  try { version = readVersion(); } catch { return 'Cannot read the installed pnpm version.'; }
  const versionError = pnpmVersionError(version);
  if (versionError) return versionError;
  const expected = manifest.packageManager.slice('pnpm@'.length);
  if (version !== expected) return `Installed pnpm ${version} does not match the pin ${expected}.`;
  return null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || (args.length === 1 && args[0] !== '--pin')) throw new Error('Usage: node scripts/check-pnpm-version.mjs [--pin]');
    const manifest = JSON.parse(readFileSync(new URL('./policy.json', import.meta.url), 'utf8'));
    const error = args[0] === '--pin' ? pnpmPinError(manifest) : pnpmRuntimeError(manifest);
    if (error) throw new Error(error);
    console.log(`${manifest.packageManager} ${args[0] === '--pin' ? 'pin' : 'runtime'} passes the package-manager policy.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
