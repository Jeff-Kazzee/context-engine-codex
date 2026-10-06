// Sizes as the core reports them: one approximation of tokens from characters, and one number format.

/**
 * Approximate token count for a size in characters: chars / 4, rounded up. An approximation, not
 * a tokenizer count; real counts vary by model and content. It exists because models estimate
 * their own context length poorly, and a readout helps (Context Language Models, App. G).
 */
export function approxTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

/** A whole number with thousands separators, as the core's texts print one (e.g. 59,101). */
export function formatInt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}
