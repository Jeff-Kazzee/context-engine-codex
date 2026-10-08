import { createHash } from 'node:crypto';
import { parseTurns } from './turns.ts';

// Delivery Modes (GLOSSARY.md): how an Adapter gets the Working Context into the runner's next
// model call. Every place that states a mode states the same label and, where the mode has known
// fidelity gaps, those gaps too; `describe()` is that one sentence.

export interface DeliveryMode {
  /** The exact label, with its granularity, e.g. 'Full Replacement per user turn'. */
  readonly label: string;
  /** Known fidelity gaps, stated wherever the mode is described. Empty when there are none. */
  readonly gaps: readonly string[];
  /** The label, followed by its gaps when there are any: `<label> (gaps: a, b)`. */
  describe(): string;
}

export function deliveryMode(label: string, gaps: readonly string[] = []): DeliveryMode {
  const frozen = Object.freeze([...gaps]);
  return Object.freeze({
    label,
    gaps: frozen,
    describe: () => (frozen.length ? `${label} (gaps: ${frozen.join(', ')})` : label),
  });
}

/**
 * The Claude Adapter's fallback for one turn (issue #22): the Working Context alone was over its
 * budget at a compaction, so the runner's own summarizer compacted instead, and its summary became
 * the next Revision. That turn is Compaction-only, never Full Replacement.
 */
export const COMPACTION_ONLY_FALLBACK = deliveryMode('Compaction-only (fallback: Working Context over budget)');

/**
 * The Codex token_budget path, for a reset the agent did not ask for: Codex's own token-limit
 * backstop (or a manual /compact) reset the window, and the PreCompact hook marked it in the file.
 * That is the runner compacting, not the agent: Compaction-only, with the Working Context reaching
 * the new window only when the agent reads it back. Never counted as Full Replacement.
 */
export const CODEX_TOKEN_LIMIT_RESET = deliveryMode('Compaction-only (Codex token-limit reset; Working Context read back by the agent)');

/** A manual /compact has the same read-back delivery, but a different trigger. */
export const CODEX_MANUAL_COMPACTION = deliveryMode('Compaction-only (Codex manual compaction; Working Context read back by the agent)');

/** A bounded copy of one committed revision. Preparing it is not proof of model delivery. */
export type WorkingContextDelivery = {
  kind: 'ready';
  revision: number;
  sha256: string;
  chars: number;
  bytes: number;
  text: string;
} | {
  kind: 'not-ready';
  revision: number;
  reason: 'empty' | 'invalid-text' | 'over-hard-limit' | 'over-budget' | 'over-delivery-limit';
  sha256: string;
  chars: number;
  bytes: number;
};

/**
 * Build only from a sync result's immutable text. The adapter chooses its transport bound.
 * All editable text stays inside one data carrier, never a system or developer message.
 */
export function prepareWorkingContextDelivery(
  snapshot: { revision: number; chars: number; workingContextText: string },
  limits: { hardLimit: number; maxBytes: number; budgetTokens?: number },
): WorkingContextDelivery {
  for (const [name, value] of Object.entries(limits)) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) throw new Error(`invalid delivery ${name}`);
  }
  const text = snapshot.workingContextText;
  if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0 || typeof text !== 'string'
      || snapshot.chars !== text.length) throw new Error('invalid committed Working Context snapshot');
  const bytes = Buffer.byteLength(text, 'utf8');
  const sha256 = createHash('sha256').update(text, 'utf8').digest('hex');
  const identity = { revision: snapshot.revision, sha256, chars: text.length, bytes };
  const refused = (reason: Extract<WorkingContextDelivery, { kind: 'not-ready' }>['reason']): WorkingContextDelivery =>
    ({ kind: 'not-ready', ...identity, reason });
  if (!text.isWellFormed() || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text)
      || /<\/working_context\s*>/i.test(text)) return refused('invalid-text');
  if (parseTurns(text).length === 0) return refused('empty');
  if (text.length > limits.hardLimit) return refused('over-hard-limit');
  if (limits.budgetTokens !== undefined && Math.ceil(text.length / 4) > limits.budgetTokens) return refused('over-budget');
  const carrier = `Context Engine: additive Working Context data. Earlier native history remains.\n<working_context revision="${snapshot.revision}" sha256="${sha256}">\n${text}\n</working_context>`;
  if (Buffer.byteLength(carrier, 'utf8') > limits.maxBytes) return refused('over-delivery-limit');
  return { kind: 'ready', ...identity, text: carrier };
}
