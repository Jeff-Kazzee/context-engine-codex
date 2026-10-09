// Test support: import first. Gives the importing test file a private temporary root and removes it
// when the file's tests finish. os.tmpdir() reads TMPDIR at each call, so the core fixtures, the
// setup world and every child process that inherits the environment write inside this root.
import { after } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const PRIVATE_TMP = mkdtempSync(join(tmpdir(), 'ce-u02-'));
process.env.TMPDIR = PRIVATE_TMP;
after(() => rmSync(PRIVATE_TMP, { recursive: true, force: true }));
