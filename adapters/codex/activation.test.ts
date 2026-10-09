// The hook's cache-local opt-in check (activation.ts) reimplements core participation without
// importing the checkout. Both must reach the same answer for every nearest-record state.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, linkSync, mkdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, tempDir } from '../../core/testing.ts';
import { participation, setParticipation } from '../../core/index.ts';
import { projectKey } from '../../core/store.ts';
import { locallyEnabled } from './plugin/hooks/activation.ts';

interface Row { record: string; directory: string; child: string; stateDir: string }

const write = (path: string, value: unknown) => writeFileSync(path, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value), { mode: 0o600 });

/** Each row edits the child's nearest record, or the participation directory, under an enabled parent, and names the expected answer. */
const ROWS: Array<[string, boolean | 'throws', (row: Row) => void]> = [
  ['absent', true, () => {}],
  ['on', true, r => setParticipation({ projectRoot: r.child, stateDir: r.stateDir, state: 'on' })],
  ['off', false, r => setParticipation({ projectRoot: r.child, stateDir: r.stateDir, state: 'off' })],
  ['corrupt JSON', false, r => write(r.record, '{broken')],
  ['invalid UTF-8', false, r => write(r.record, Buffer.from([0xff, 0xfe, 0x7b]))],
  ['mismatched projectRoot', false, r => write(r.record, { projectRoot: '/elsewhere', state: 'on' })],
  ['unknown state', false, r => write(r.record, { projectRoot: r.child, state: 'maybe' })],
  ['oversized', 'throws', r => write(r.record, { projectRoot: r.child, state: 'on', pad: 'x'.repeat(17_000) })],
  ['non-private record', 'throws', r => { write(r.record, { projectRoot: r.child, state: 'on' }); chmodSync(r.record, 0o644); }],
  ['hard-linked record', 'throws', r => { write(r.record, { projectRoot: r.child, state: 'on' }); linkSync(r.record, `${r.record}.alias`); }],
  ['symlinked record', 'throws', r => { const target = join(tempDir('record-target'), 'record.json'); write(target, { projectRoot: r.child, state: 'on' }); symlinkSync(target, r.record); }],
  ['non-private participation directory', 'throws', r => chmodSync(r.directory, 0o755)],
  ['linked participation directory', 'throws', r => { renameSync(r.directory, `${r.directory}.real`); symlinkSync(`${r.directory}.real`, r.directory); }],
];

function outcome(read: () => boolean): boolean | 'throws' {
  try { return read(); } catch { return 'throws'; }
}

function withStateDir<T>(stateDir: string, read: () => T): T {
  const previous = process.env.CONTEXT_ENGINE_STATE_DIR;
  process.env.CONTEXT_ENGINE_STATE_DIR = stateDir;
  try { return read(); }
  finally { if (previous === undefined) delete process.env.CONTEXT_ENGINE_STATE_DIR; else process.env.CONTEXT_ENGINE_STATE_DIR = previous; }
}

for (const [name, expected, mutate] of ROWS) test(`[CORE-036] Codex locallyEnabled agrees with core participation: ${name}`, () => {
  const f = fixture(), child = join(f.projectRoot, 'child');
  mkdirSync(child);
  setParticipation({ ...f, state: 'on' });
  const directory = join(f.stateDir, 'participation');
  mutate({ record: join(directory, `${projectKey(child)}.json`), directory, child, stateDir: f.stateDir });
  const codex = withStateDir(f.stateDir, () => outcome(() => locallyEnabled(child)));
  const core = outcome(() => participation({ projectRoot: child, stateDir: f.stateDir, env: {} }).active);
  assert.equal(codex, core, `activation.ts says ${codex}, core participation says ${core}`);
  assert.equal(core, expected);
});
