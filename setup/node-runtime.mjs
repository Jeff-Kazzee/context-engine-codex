// Fixed release floors from the October 21, 2026 Node.js security advisory:
// https://nodejs.org/en/blog/vulnerability/october-2026-security-releases
const minimums = new Map([[24, [22, 1]], [26, [12, 1]]]);

export function assertSupportedNode(version = process.versions.node) {
  const match = typeof version === 'string'
    ? /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version)
    : null;
  const parts = match?.slice(1).map(Number);
  const minimum = parts && parts.every(Number.isSafeInteger) && minimums.get(parts[0]);
  if (minimum && (parts[1] > minimum[0] || (parts[1] === minimum[0] && parts[2] >= minimum[1]))) return;
  const error = new Error(`CE_UNSUPPORTED_NODE: Context Engine requires stable Node.js 24.22.1+ in the 24.x line or 26.12.1+ in the 26.x line. Received ${JSON.stringify(version)}. Update Node before install, tests, typecheck or release checks. Other majors and custom/prerelease builds require a supported-runtime policy decision.`);
  error.code = 'CE_UNSUPPORTED_NODE';
  throw error;
}
