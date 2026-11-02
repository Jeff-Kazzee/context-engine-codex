/** Reject Win32 aliases before a multi-component operation can create a prefix. */
export function assertWindowsComponent(name: string): void {
  const stem = name.split('.')[0]!.toUpperCase();
  if (!name || name.length > 255 || name === '.' || name === '..' || /[. ]$/.test(name)
    || /[\x00-\x1f\\/:*?"<>|]/.test(name)
    || /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$)$/.test(stem)
    || /^(?:COM|LPT)[1-9\u00b9\u00b2\u00b3]$/.test(stem)) {
    throw Object.assign(new Error(`unsafe Windows path component ${JSON.stringify(name)}`), { code: 'EINVAL' });
  }
}
