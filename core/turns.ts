// Working Context turn-block format.
//
// The format follows Shao et al., "Context Language Models" (arXiv:2609.37725, CC BY 4.0, Sec. 4.1
// and Fig. 3): the editable context is a plain-text file in which each turn starts with a
// `[[CTX_TURN <n> role=<role>]]` header line.
//
// Parsing is tolerant, because the model edits this file freely. The rules below re-implement, in
// our own code, the upstream harness's parse behaviour as summarized in prose in our research note
// (facebookresearch/context-language-models `parse_back`, commit 18dc111, CC BY-NC 4.0; see
// PROVENANCE.md). No upstream code or regular expression was used. Optional turn numbers, loose
// header spacing/case and the escaping of header lookalikes are our own.
// - text before the first header (or in a file with no headers) becomes a user turn;
// - `assistant` stays assistant; every other role (user, tool, system, invented ones) folds to user;
// - turn numbers are ignored (and may be omitted); spacing and case in the header are loose;
// - turns whose body is blank are dropped;
// - consecutive turns with the same role are merged, separated by a blank line.
//
// Rendering escapes body lines that would parse as a header by prefixing one backslash, and
// parsing removes one, so runner text can never forge a turn boundary and round-trips exactly.

export type Role = 'user' | 'assistant';

export interface Turn {
  role: Role;
  text: string;
}

const HEADER = /^\[\[ctx_turn(?:\s+\d+)?\s+role=([A-Za-z][\w-]*)\s*\]\]\s*$/i;

const isHeaderLike = (line: string): boolean => HEADER.test(line.replace(/^\\+/, ''));

/** Normalizes a block body: drop leading blank lines and trailing whitespace. */
const tidy = (body: string): string => body.replace(/^(?:[ \t]*\r?\n)+/, '').replace(/\s+$/, '');

/** Renders one block header. `role` may be any runner label; non-word characters are dropped. */
export function renderHeader(n: number, role: string): string {
  const safe = role.replace(/[^\w-]/g, '').replace(/^[^A-Za-z]+/, '') || 'user';
  return `[[CTX_TURN ${n} role=${safe}]]`;
}

/** Escapes body lines that would otherwise parse as a turn header. */
export function escapeBody(text: string): string {
  return text
    .split('\n')
    .map((line) => (isHeaderLike(line) ? `\\${line}` : line))
    .join('\n');
}

function unescapeBody(text: string): string {
  return text
    .split('\n')
    .map((line) => (line.startsWith('\\') && isHeaderLike(line) ? line.slice(1) : line))
    .join('\n');
}

/** Renders runner-neutral turns as a Working Context, numbered from `firstNumber`. */
export function renderTurns(turns: ReadonlyArray<{ role: string; text: string }>, firstNumber = 1): string {
  return turns
    .map((t, i) => `${renderHeader(firstNumber + i, t.role)}\n${escapeBody(tidy(t.text))}\n`)
    .join('\n');
}

/** Counts header lines, so appended blocks can continue the numbering. */
export function countHeaders(text: string): number {
  return text.split('\n').filter((line) => HEADER.test(line)).length;
}

/** Parses a Working Context into normalized runner-neutral turns. Never throws. */
export function parseTurns(text: string): Turn[] {
  const blocks: Turn[] = [];
  let role: Role = 'user';
  let body: string[] = [];
  const flush = () => blocks.push({ role, text: tidy(unescapeBody(body.join('\n'))) });

  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const m = HEADER.exec(line);
    if (!m) {
      body.push(line);
      continue;
    }
    flush();
    role = m[1]!.toLowerCase() === 'assistant' ? 'assistant' : 'user';
    body = [];
  }
  flush();

  const turns: Turn[] = [];
  for (const b of blocks) {
    if (b.text === '') continue;
    const last = turns.at(-1);
    if (last && last.role === b.role) last.text = `${last.text}\n\n${b.text}`;
    else turns.push({ ...b });
  }
  return turns;
}
