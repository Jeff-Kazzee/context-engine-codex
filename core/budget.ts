// Curation pressure (issue #22): a size readout and budget reminders, measured on the Working
// Context against the budget its adapter gives it.
//
// Provenance (PROVENANCE.md):
// - The size readout follows the paper, *Context Language Models* (Shao et al., 2026; CC BY 4.0),
//   App. G: models estimate their own context length poorly, and a readout helps.
// - The reminder schedule is behaviour re-implemented in our own code and wording from the upstream
//   harness's described behaviour (facebookresearch/context-language-models, CC BY-NC 4.0, commit
//   18dc11115f50f261233c5bba7937834491e307e8, `clm/clm_harness/utils/budget.py`: `nudge_message`
//   and `adaptive_persistent_trigger`, as summarized in prose in our research note, branch
//   `research/clm-paper-and-upstream`, §3). No code or prompt strings were copied. What it takes:
//   reminders at 25/50/75% of the budget, and an urgent reminder on every check once headroom is
//   under max(10% of the budget, twice the largest recent growth), capped at half the budget.
// - The 25% reminder only reports the size and says nothing about what to do. That is our design
//   choice (the upstream harness's 25% tier is likewise informational): the earliest reminder
//   should not prompt curation.
//
// Every text here is static, with numbers filled in. None of it ever contains model-authored text.
// No content schema and no editing strategy are prescribed: the reminders say where the Working
// Context stands, not what to do with it.

import { approxTokens, formatInt } from './size.ts';

export const BUDGET_TIERS = [25, 50, 75] as const;
export type BudgetTier = 0 | (typeof BUDGET_TIERS)[number];

/** Where the Working Context stands against its budget, at one sync or record. */
export interface BudgetReport {
  /** The Working Context's budget, in tokens, as the adapter gave it. */
  budgetTokens: number;
  /** Working Context size, approximated as chars / 4. */
  approxTokens: number;
  /** approxTokens over budgetTokens as a whole percentage (past 100 when over). */
  percent: number;
  /** The Working Context alone is larger than its budget. */
  overBudget: boolean;
  /** The tier this check announced (0 = none). Each tier is announced once while the Working Context grows past it. */
  tier: BudgetTier;
  /** Headroom is under the urgent margin (over budget included). Fires on every check while it holds. */
  urgent: boolean;
  /** The readout line, then the reminder lines this check fired. Static text and numbers only. */
  text: string;
}

/** What the budget checks remember between calls: derived from the Event Log (see budgetMemory). */
export interface BudgetMemory {
  /** Highest tier announced since the Working Context was last below it. */
  announced: BudgetTier;
  /** Growth of the last three runner appends, in tokens. */
  growth: number[];
  /** Size of the latest revision, in tokens. */
  lastTokens: number;
  /** The budget last logged (a `budget` entry), or null. */
  loggedBudget: number | null;
}

export function tierOf(tokens: number, budgetTokens: number): BudgetTier {
  let t: BudgetTier = 0;
  for (const tier of BUDGET_TIERS) if (tokens * 100 >= tier * budgetTokens) t = tier;
  return t;
}

/**
 * Folds Event Log entries into what the checks remember: revisions (their sizes give growth, and a
 * shrink below an announced tier re-arms it) and the reminders already fired.
 */
export function budgetMemory(entries: Iterable<Record<string, unknown>>, budgetTokens: number): BudgetMemory {
  const m: BudgetMemory = { announced: 0, growth: [], lastTokens: 0, loggedBudget: null };
  for (const e of entries) {
    if (e.type === 'revision') {
      remember(m, String(e.kind), Number(e.chars) || 0, budgetTokens);
    } else if (e.type === 'budget-reminder' && typeof e.tier === 'number' && e.tier > m.announced) {
      m.announced = e.tier as BudgetTier;
    } else if (e.type === 'budget' && typeof e.budgetTokens === 'number') {
      m.loggedBudget = e.budgetTokens;
    }
  }
  return m;
}

/** Updates the memory for one committed revision of `chars` characters, of the given kind. */
export function remember(m: BudgetMemory, kind: string, chars: number, budgetTokens: number): void {
  const tokens = approxTokens(chars);
  if (kind === 'runner-append') m.growth = [...m.growth, Math.max(0, tokens - m.lastTokens)].slice(-3);
  m.lastTokens = tokens;
  const now = tierOf(tokens, budgetTokens);
  if (now < m.announced) m.announced = now;
}

/** The urgent margin: max(10% of the budget, twice the largest recent growth), at most half the budget. */
export function urgentMargin(m: BudgetMemory, budgetTokens: number): number {
  return Math.min(budgetTokens / 2, Math.max(budgetTokens / 10, 2 * Math.max(0, ...m.growth)));
}

const TIER_TEXT: Record<Exclude<BudgetTier, 0>, string> = {
  // Informational only (see the header).
  25: 'Context Engine: the Working Context has passed 25% of its budget.',
  50: 'Context Engine: the Working Context has passed 50% of its budget. What it keeps is up to you; nothing taken out of it is lost from the Event Log.',
  75: 'Context Engine: the Working Context has passed 75% of its budget. Once it is over budget it cannot be delivered as it stands; your instructions say what happens then.',
};

/**
 * One check of a Working Context of `chars` characters against `budgetTokens`. Returns the report
 * and the tier and urgency to remember; the caller logs a fired reminder (see Session).
 */
export function checkBudget(m: BudgetMemory, chars: number, budgetTokens: number): BudgetReport {
  const tokens = approxTokens(chars);
  const percent = Math.floor((tokens * 100) / budgetTokens);
  const overBudget = tokens > budgetTokens;
  const now = tierOf(tokens, budgetTokens);
  const tier: BudgetTier = now > m.announced ? now : 0;
  const urgent = budgetTokens - tokens < urgentMargin(m, budgetTokens);
  const lines = [`Context Engine: Working Context ~${formatInt(tokens)} tokens of its ~${formatInt(budgetTokens)}-token budget (${percent}%; approx., chars/4).`];
  if (tier) lines.push(TIER_TEXT[tier]);
  if (overBudget) {
    lines.push(`Context Engine: the Working Context is over its budget by ~${formatInt(tokens - budgetTokens)} tokens, so it cannot be delivered as it stands; your instructions say what happens then.`);
  } else if (urgent) {
    lines.push(`Context Engine: URGENT: the Working Context is within ~${formatInt(budgetTokens - tokens)} tokens of its budget. Once it is over budget it cannot be delivered as it stands; your instructions say what happens then.`);
  }
  return { budgetTokens, approxTokens: tokens, percent, overBudget, tier, urgent, text: lines.join('\n') };
}
