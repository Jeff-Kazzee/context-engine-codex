#!/usr/bin/env node
// Test support: a stand-in for the Codex process that runs hooks. It reads a JSON array of hook
// events on stdin, runs the hook once per event as its own child, in order, prints one JSON line per
// result and exits. Every hook presents this process as its session-lock owner, so two runner
// processes in sequence model a Codex restart that resumes the same thread.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HOOK = fileURLToPath(new URL('../plugin/hooks/codex-hook.ts', import.meta.url));

for (const event of JSON.parse(readFileSync(0, 'utf8')) as unknown[]) {
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(event), encoding: 'utf8', timeout: 40_000, killSignal: 'SIGKILL' });
  process.stdout.write(`${JSON.stringify({ status: r.status, stdout: r.stdout, stderr: r.stderr })}\n`);
}
