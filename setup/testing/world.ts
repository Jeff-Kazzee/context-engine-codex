// Test helpers for setup: scratch runner homes and a CLI runner. Nothing here touches the real
// ~/.claude, ~/.codex or XDG state: every path is a fresh temp dir, and the runner binaries are the
// fakes beside this file.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from '../../core/testing.ts';

export const CLI = fileURLToPath(new URL('../../core/cli.ts', import.meta.url));
export const FAKE_CLAUDE = fileURLToPath(new URL('./fake-claude.ts', import.meta.url));
export const FAKE_CODEX = fileURLToPath(new URL('./fake-codex.ts', import.meta.url));

export interface World {
  home: string;
  claudeHome: string;
  codexHome: string;
  stateDir: string;
  project: string;
  env: Record<string, string>;
  /** Runs `context-engine <args>` with the world's env. */
  ce(args: string[], opts?: { cwd?: string; env?: Record<string, string>; input?: string }): { status: number | null; stdout: string; stderr: string };
}

export function world(): World {
  const home = tempDir('home');
  const claudeHome = join(home, '.claude');
  const codexHome = join(home, '.codex');
  mkdirSync(claudeHome);
  mkdirSync(codexHome);
  const stateDir = join(tempDir('state'), 'context-engine');
  const project = tempDir('project');
  const env: Record<string, string> = {
    HOME: home,
    CLAUDE_CONFIG_DIR: claudeHome,
    CODEX_HOME: codexHome,
    CONTEXT_ENGINE_STATE_DIR: stateDir,
    CONTEXT_ENGINE_CLAUDE_BIN: FAKE_CLAUDE,
    CONTEXT_ENGINE_CODEX_BIN: FAKE_CODEX,
    CONTEXT_ENGINE: '',
    CONTEXT_ENGINE_EXPERIMENTS: '',
    CONTEXT_ENGINE_CLAUDE_MODE: '',
    XDG_STATE_HOME: '/nonexistent-should-not-be-used',
  };
  return {
    home,
    claudeHome,
    codexHome,
    stateDir,
    project,
    env,
    ce(args, opts = {}) {
      const r = spawnSync(process.execPath, [CLI, ...args], {
        cwd: opts.cwd ?? project,
        encoding: 'utf8',
        input: opts.input,
        env: { ...process.env, ...env, ...opts.env },
      });
      return { status: r.status, stdout: r.stdout, stderr: r.stderr };
    },
  };
}

/** Every file (sha256) and directory under `root`, relative: a byte-level picture of a tree. */
export function tree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const rel = relative(root, path);
      if (lstatSync(path).isDirectory()) {
        out[`${rel}/`] = 'dir';
        walk(path);
      } else out[rel] = createHash('sha256').update(readFileSync(path)).digest('hex');
    }
  };
  if (existsSync(root)) walk(root);
  return out;
}
