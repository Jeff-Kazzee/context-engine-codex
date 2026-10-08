#!/usr/bin/env node
// context-engine-codex-turns: run a Codex session headlessly, turn by turn, with Full Replacement
// per user turn. A thin shell over startTurnLoop(); prints one JSON object per line.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { startTurnLoop, type TurnResult } from './turn-loop.ts';

const HELP = `context-engine-codex-turns: Codex app-server turn loop (Full Replacement per user turn).

Usage: context-engine-codex-turns --session <id> [options] [--prompt <text>]...

Spawns its own \`codex app-server --listen stdio://\` (never the shared daemon
socket) and runs one user turn per prompt. Before each turn the committed
Working Context is validated and injected as one user message into a fresh
thread. A Working Context that can't be delivered fails closed: the turn is
refused with a receipt, with no model call and no continuation of an earlier
thread. The app-server always runs with -c features.token_budget=false and
-c plugins.context-engine@context-engine.enabled=false (after any -c given
here), so the Codex plugin path cannot act on these threads.
Run it again with the same --session to resume.

Options:
  --session <id>       Core session id (letters, digits, '.', '_', '-').
  --project <dir>      Project root and app-server cwd (default: current dir).
  --prompt <text>      A user turn; repeatable. Without --prompt, each
                       non-empty stdin line is a turn.
  --model <name>       Codex model.
  --effort <level>     Reasoning effort per turn, e.g. low.
  --hard-limit <n>     Working Context hard limit in characters (default 400000).
  -c <key=value>       Per-process Codex config override; repeatable.
  --codex <bin|json>   Codex executable, or a JSON array command (default codex).
  --stderr <file>      Append the app-server's stderr here (default: discarded).
  -h, --help           Show this help.

Output (stdout, one JSON object per line):
  {"event":"start","mode","sessionId","workingContext"}
  {"event":"turn","mode","turn","status","replaced","revisionInjected",
   "revisionAfter","receipts","threadId","turnId","finalMessage","itemCount",
   "usage","error"}                      status: completed|failed|interrupted|refused
                                         mode: null on a refused turn
  {"event":"end"}
  {"event":"error","error"}              exit 1
A refused turn (undeliverable Working Context) stops the run: exit 3.
With the kill switch CONTEXT_ENGINE=off the turn loop does not start (exit 1). It needs no
context-engine enable: running it is the opt-in.
`;

class Usage extends Error {}

async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      session: { type: 'string' },
      project: { type: 'string' },
      prompt: { type: 'string', multiple: true },
      model: { type: 'string' },
      effort: { type: 'string' },
      'hard-limit': { type: 'string' },
      c: { type: 'string', short: 'c', multiple: true },
      codex: { type: 'string' },
      stderr: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (!values.session) throw new Usage('--session is required (see --help)');
  let hardLimit: number | undefined;
  if (values['hard-limit'] !== undefined) {
    hardLimit = Number(values['hard-limit']);
    if (!Number.isSafeInteger(hardLimit) || hardLimit <= 0) throw new Usage('--hard-limit must be a positive integer');
  }
  const command = values.codex === undefined ? undefined : values.codex.startsWith('[') ? (JSON.parse(values.codex) as string[]) : [values.codex];
  const prompts = values.prompt?.length
    ? values.prompt
    : readFileSync(0, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);

  const loop = await startTurnLoop({
    projectRoot: values.project ?? process.cwd(),
    sessionId: values.session,
    model: values.model,
    effort: values.effort,
    hardLimit,
    configOverrides: values.c,
    command,
    stderrPath: values.stderr,
  });
  try {
    print({ event: 'start', mode: loop.mode, sessionId: loop.sessionId, workingContext: loop.workingContextPath });
    for (const prompt of prompts) {
      const r = await loop.runTurn(prompt);
      print(turnLine(r));
      if (r.status === 'refused') return 3;
    }
    print({ event: 'end' });
    return 0;
  } finally {
    await loop.close();
  }
}

function turnLine(r: TurnResult): object {
  const { items, ...rest } = r;
  return { event: 'turn', ...rest, itemCount: items.length };
}

function print(obj: object): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (e) {
  print({ event: 'error', error: e instanceof Error ? e.message : String(e) });
  process.exitCode = 1;
}
