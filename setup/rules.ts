// How setup recognises its own entries in runner config files (see ledger.ts `Rule`).
import type { Rule } from './ledger.ts';

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const sortKeys = (v: unknown): unknown => (isObject(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : Array.isArray(v) ? v.map(sortKeys) : v);

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function has(obj: unknown, path: string[]): boolean {
  let cur = obj;
  for (const k of path) {
    if (!isObject(cur) || !(k in cur)) return false;
    cur = cur[k];
  }
  return true;
}

/**
 * A JSON file where our entries are the keys at `paths` (e.g. ['enabledPlugins', 'x@y']). A
 * container our removal empties is removed too, unless the file had it before. A file that isn't
 * JSON is left alone. The rewrite is 2-space indented, as Claude Code writes these files.
 */
export function jsonRule(paths: string[][]): Rule {
  return {
    empty(text) { const value = parse(text); return isObject(value) && Object.keys(value).length === 0; },
    strip(text, before) {
      const obj = parse(text);
      if (!isObject(obj)) return text;
      const prior = before === null ? undefined : parse(before);
      let changed = false;
      for (const path of paths) {
        const restore = has(prior, path);
        const parents: Json[] = [obj];
        for (const k of path.slice(0, -1)) {
          const parent = parents.at(-1)!;
          if (!(k in parent) && restore) { parent[k] = {}; changed = true; }
          const next = parent[k];
          if (!isObject(next)) break;
          parents.push(next);
        }
        if (parents.length !== path.length) continue;
        const last = path.at(-1)!;
        const parent = parents.at(-1)!;
        if (restore) {
          let original: unknown = prior;
          for (const key of path) original = (original as Json)[key];
          if (JSON.stringify(parent[last]) !== JSON.stringify(original)) {
            parent[last] = original;
            changed = true;
          }
        } else if (last in parent) {
          delete parent[last];
          changed = true;
        }
        for (let depth = path.length - 1; depth > 0; depth--) {
          const container = parents[depth]!;
          if (Object.keys(container).length === 0 && !has(prior, path.slice(0, depth))) {
            delete parents[depth - 1]![path[depth - 1]!];
            changed = true;
          }
        }
      }
      return changed ? `${JSON.stringify(obj, null, 2)}${text.endsWith('\n') ? '\n' : ''}` : text;
    },
    canon(text) {
      const obj = parse(text);
      return obj === undefined ? text : JSON.stringify(sortKeys(obj));
    },
  };
}

const header = (line: string) => /^\s*\[/.test(line);

/**
 * A TOML file where our entries are whole tables whose header line matches `ours`. A table is
 * its header through the line before the next header; the blank line separating it from the
 * previous table goes with it. Empty parent tables (e.g. `[hooks.state]`) matching `emptyParents`
 * are removed when the file didn't have them before. Text-level, so comments elsewhere are kept.
 */
export function tomlTablesRule(ours: RegExp, emptyParents: RegExp): Rule {
  const strip = (text: string, before: string | null) => {
    const lines = text.split('\n');
    const priorHeaders = new Set((before ?? '').split('\n').filter(header).map((l) => l.trim()));
    const out: string[] = [];
    for (let i = 0; i < lines.length; ) {
      const line = lines[i]!;
      const ourTable = header(line) && ours.test(line.trim());
      let end = i + 1;
      while (end < lines.length && !header(lines[end]!)) end++;
      const body = lines.slice(i + 1, end);
      const emptyParent = header(line) && emptyParents.test(line.trim()) && !priorHeaders.has(line.trim()) && body.every((l) => l.trim() === '');
      if (!ourTable && !emptyParent) {
        out.push(line);
        i++;
        continue;
      }
      // Drop the table; keep a blank line that separates it from the next table.
      if (out.length && out.at(-1) === '') out.pop();
      const trailingBlank = end - 1 > i && lines[end - 1] === '';
      if (trailingBlank) out.push('');
      i = end;
    }
    return out.join('\n');
  };
  return {
    strip,
    empty: (text) => text.trim() === '',
    canon: (text) =>
      text
        .split('\n')
        .map((l) => l.trimEnd())
        .filter((l) => l !== '')
        .join('\n'),
  };
}

/** Marker lines around a block setup writes into a file it doesn't own. */
export interface Markers {
  begin: string;
  end: string;
}

/** Appends `block` between the markers, after a blank line. */
export function appendBlock(text: string | null, block: string, m: Markers): string {
  const t = text ?? '';
  const sep = t === '' ? '' : t.endsWith('\n\n') ? '' : t.endsWith('\n') ? '\n' : '\n\n';
  return `${t}${sep}${m.begin}\n${block.endsWith('\n') ? block : `${block}\n`}${m.end}\n`;
}

/** Puts `block` between the markers at the start of the file, followed by a blank line before the rest. */
export function prependBlock(text: string | null, block: string, m: Markers): string {
  const t = text ?? '';
  return `${m.begin}\n${block.endsWith('\n') ? block : `${block}\n`}${m.end}\n${t === '' ? '' : `\n${t}`}`;
}

/** A file where our entry is one marked block (appendBlock at the end, or prependBlock at the start). */
export function blockRule(m: Markers): Rule {
  return {
    strip(text) {
      const start = text.indexOf(`${m.begin}\n`);
      const stop = text.indexOf(`${m.end}\n`, start);
      if (start < 0 || stop < 0) return text;
      let from = start;
      let to = stop + m.end.length + 1;
      // The blank line prependBlock put after a block at the start of the file.
      if (start === 0 && text[to] === '\n') to++;
      // The blank line appendBlock put before the block.
      else if (from > 1 && text[from - 1] === '\n' && text[from - 2] === '\n') from--;
      return text.slice(0, from) + text.slice(to);
    },
    canon: (text) =>
      text
        .split('\n')
        .map((l) => l.trimEnd())
        .filter((l) => l !== '')
        .join('\n'),
  };
}
