// The one item the turn loop ever injects, and the checks it passes before it is sent.
//
// Codex's `thread/inject_items` takes raw Responses API items and silently accepts anything that
// deserializes, including `{"type":"nonsense"}` (it becomes `ResponseItem::Other`). So the turn loop
// validates its own items: exactly one user message whose content is non-empty `input_text` parts,
// with no other keys. The Working Context never goes in as developer or system content.
import { parseTurns } from '../../../core/index.ts';

export interface InputTextPart {
  type: 'input_text';
  text: string;
}

export interface UserMessageItem {
  type: 'message';
  role: 'user';
  content: InputTextPart[];
}

/** Why a committed Working Context was not delivered. */
export type WorkingContextRejectReason = 'empty' | 'control-characters' | 'carrier-tag' | 'over-hard-limit';

const CARRIER_CLOSE = '</working_context>';
// C0 controls and DEL, except tab, line feed and carriage return.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

const sameKeys = (o: object, keys: string[]): boolean => {
  const own = Object.keys(o);
  return own.length === keys.length && keys.every((k) => own.includes(k));
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Returns the problems with an inject payload; an empty list means it may be sent. */
export function validateInjectItems(items: unknown): string[] {
  if (!Array.isArray(items)) return ['items must be an array'];
  if (items.length !== 1) return [`expected exactly one item, got ${items.length}`];
  const item: unknown = items[0];
  if (!isObject(item)) return ['item must be an object'];
  const problems: string[] = [];
  if (!sameKeys(item, ['type', 'role', 'content'])) problems.push('item keys must be exactly type, role, content');
  if (item.type !== 'message') problems.push('item type must be "message"');
  if (item.role !== 'user') problems.push('item role must be "user"');
  const content = item.content;
  if (!Array.isArray(content) || content.length === 0) {
    problems.push('content must be a non-empty array');
    return problems;
  }
  content.forEach((part: unknown, i) => {
    if (!isObject(part) || !sameKeys(part, ['type', 'text'])) problems.push(`content[${i}] keys must be exactly type, text`);
    else if (part.type !== 'input_text') problems.push(`content[${i}] type must be "input_text"`);
    else if (typeof part.text !== 'string' || part.text === '') problems.push(`content[${i}] text must be a non-empty string`);
  });
  return problems;
}

const attr = (s: string): string => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export type WorkingContextItems =
  | { ok: true; items: [UserMessageItem] }
  | { ok: false; reason: WorkingContextRejectReason; detail: string };

/**
 * Wraps a committed Working Context as the single user message to inject, or says why it can't be.
 * The core already restores a missing, empty, non-UTF-8 or oversized model edit from HEAD; these
 * checks catch what the core accepts but the carrier can't deliver safely.
 */
export function workingContextItems(text: string, opts: { path: string; hardLimit: number }): WorkingContextItems {
  if (parseTurns(text).length === 0) return { ok: false, reason: 'empty', detail: 'it holds no turn with any text' };
  if (CONTROL.test(text)) return { ok: false, reason: 'control-characters', detail: 'it contains control characters (NUL or similar)' };
  if (/<\/working_context\s*>/i.test(text)) return { ok: false, reason: 'carrier-tag', detail: `it contains the carrier tag ${CARRIER_CLOSE}` };
  if (text.length > opts.hardLimit) {
    return { ok: false, reason: 'over-hard-limit', detail: `it is ${text.length} chars, over the hard limit of ${opts.hardLimit}` };
  }
  const body = text.replace(/\s+$/, '');
  const item: UserMessageItem = {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: `<working_context path="${attr(opts.path)}">\n${body}\n${CARRIER_CLOSE}` }],
  };
  const problems = validateInjectItems([item]);
  if (problems.length) throw new Error(`internal: built an invalid inject item: ${problems.join('; ')}`);
  return { ok: true, items: [item] };
}
