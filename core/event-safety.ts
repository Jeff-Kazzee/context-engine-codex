import type { RunnerEvent } from './session.ts';

/** Recognized credentials are omitted as whole events, never copied into diagnostic metadata. */
const sensitiveKey = (key: string): boolean => {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return /(apikey|accesskey|secretkey|clientsecret|secret|password|privatekey|authorization|credentials?|accesstoken|refreshtoken|authtoken|oauthtoken)$/.test(normalized)
    || normalized.endsWith('token') || ['auth', 'bearer', 'cookie', 'setcookie'].includes(normalized);
};

function credentialText(text: string): boolean {
  if (/\b(?:Authorization\s*:\s*|Proxy-Authorization\s*:\s*|(?:Set-)?Cookie\s*:\s*)\S/i.test(text)
    || /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/i.test(text)
    || /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/.test(text)
    || /\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/.test(text)) return true;
  // Assignment/header/JSON labels: inspect only recognized key names, not arbitrary entropy.
  const assignments = /(?:^|[\s"'`({,;])([A-Za-z_][A-Za-z0-9_-]{0,127})["']?\s*[:=]\s*["']?[^\s"',;}\]]+/g;
  for (const match of text.matchAll(assignments)) if (sensitiveKey(match[1]!)) return true;
  return false;
}

/** Inspection visits at most 1 Mi UTF-16 units, 10,000 nodes and depth 32 per event. */
export function retainRunnerEvent(event: RunnerEvent): RunnerEvent {
  let chars = 0, nodes = 0;
  const seen = new Set<object>();
  let reason: 'omitted-credential' | 'omitted-inspection-limit' | undefined;
  const visit = (value: unknown, depth: number): unknown => {
    if (reason) return undefined;
    if (++nodes > 10000 || depth > 32) { reason = 'omitted-inspection-limit'; return undefined; }
    if (typeof value === 'string') {
      chars += value.length;
      if (chars > 1024 * 1024) { reason = 'omitted-inspection-limit'; return undefined; }
      if (credentialText(value)) reason = 'omitted-credential';
      return value;
    }
    if (value === null || typeof value === 'boolean' || typeof value === 'number' || value === undefined) return value;
    if (typeof value !== 'object' || seen.has(value)) { reason = 'omitted-inspection-limit'; return undefined; }
    const proto = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) { reason = 'omitted-inspection-limit'; return undefined; }
    seen.add(value);
    const out: Record<string, unknown> | unknown[] = Array.isArray(value) ? [] : Object.create(null);
    for (const key of Object.keys(value)) {
      chars += key.length;
      if (chars > 1024 * 1024 || nodes >= 10000) { reason = 'omitted-inspection-limit'; break; }
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!('value' in descriptor)) { reason = 'omitted-inspection-limit'; break; }
      const item = descriptor.value;
      if (sensitiveKey(key) && item !== null && item !== undefined && item !== '') { reason = 'omitted-credential'; break; }
      Object.defineProperty(out, key, { value: visit(item, depth + 1), enumerable: true, configurable: true, writable: true });
      if (reason) break;
    }
    seen.delete(value);
    return out;
  };
  const retained = visit(event, 0) as RunnerEvent;
  if (!reason) return retained;
  const role = Object.getOwnPropertyDescriptor(event, 'role');
  return { role: role && 'value' in role && role.value === 'assistant' ? 'assistant' : 'user', text: '[Context Engine omitted a runner event under its credential-retention policy.]', retention: reason };
}
