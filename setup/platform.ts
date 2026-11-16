import { requireSupportedPlatform } from '../core/platform.ts';

/** Windows storage is being accepted separately from native plugin integration. */
export function requireVerifiedIntegration(): void {
  if (process.platform === 'win32') {
    throw Object.assign(new Error('Native Windows plugin setup and hooks have not passed acceptance. No runner configuration was changed. The Windows core backend is under development.'), { code: 'CE_WINDOWS_INTEGRATION_UNVERIFIED' });
  }
  requireSupportedPlatform();
}
