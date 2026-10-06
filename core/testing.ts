// Test helpers (not part of the public interface). Every test gets fresh temp dirs; nothing
// touches the real home directory or XDG state.
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function tempDir(label: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), `ce-${label}-`)));
}

export function fixture() {
  const stateDir = join(tempDir('state'), 'context-engine');
  const projectRoot = tempDir('project');
  return { stateDir, projectRoot };
}
