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
