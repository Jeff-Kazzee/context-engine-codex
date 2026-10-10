// Setup restores runner config from records it wrote earlier. A foreign record cannot say what to
// restore, so setup refuses before it changes anything. A backup copy that is gone is never read as
// an absent file: uninstall removes only Context Engine's entries from that file and names the copy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, linkSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tempDir } from '../core/testing.ts';
import { killGroup, startSetup, waitForFile } from './testing/process.ts';
import { tree, world } from './testing/world.ts';

const snapshotOf = (record: string) => JSON.parse(readFileSync(record, 'utf8')).dir as string;

test('[LIFE-015] a missing before backup of an interrupted install is reported, never read as an absent file', async () => {
  const w = world();
  const config = join(w.codexHome, 'config.toml');
  writeFileSync(config, '');
  const pause = join(tempDir('pause'), 'plugin-add');
  const install = startSetup(['install'], { cwd: w.project, env: { ...w.env, FAKE_CODEX_PAUSE: pause } });
  try { await waitForFile(pause); } finally { killGroup(install.pid); }
  assert.equal((await install.done).signal, 'SIGKILL');
  rmSync(join(w.stateDir, 'setup', 'codex.setup.lock'));
  const pending = join(w.stateDir, 'setup', 'codex.pending.json');
  const copy = join(snapshotOf(pending), 'before', '0-config.toml');
  unlinkSync(copy);

  const r = w.ce(['uninstall']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(existsSync(config), 'config.toml is never deleted on the word of a missing backup');
  assert.doesNotMatch(readFileSync(config, 'utf8'), /context-engine/, 'only Context Engine entries were removed');
  assert.ok(r.stdout.includes(`because its before backup ${copy} is missing`), `uninstall names the copy it could not use:\n${r.stdout}`);
  assert.equal(existsSync(pending), false, 'the undo finished');
});

test('[LIFE-004] a missing backup copy blocks no command, and uninstall names the file it could not restore', () => {
  for (const which of ['before', 'after']) {
    const w = world();
    const config = join(w.codexHome, 'config.toml');
    writeFileSync(config, '');
    assert.equal(w.ce(['install']).status, 0);
    const pointer = join(w.stateDir, 'setup', 'codex.json');
    const copy = join(snapshotOf(pointer), which, '0-config.toml');
    unlinkSync(copy);

    for (const command of ['status', 'enable']) {
      const r = w.ce([command]);
      assert.equal(r.status, 0, `${which}: ${command} does not read backup copies:\n${r.stderr}`);
    }
    assert.match(w.ce(['install']).stderr, /already installed/, `${which}: install still says it is installed`);
    const r = w.ce(['uninstall']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(existsSync(config), `${which}: config.toml is never deleted on the word of a missing backup`);
    assert.doesNotMatch(readFileSync(config, 'utf8'), /context-engine/, `${which}: only Context Engine entries were removed`);
    const line = r.stdout.split('\n').find((l) => l.includes(`${config}:`)) ?? '';
    assert.ok(line.includes(copy), `${which}: uninstall names the copy it could not use:\n${r.stdout}`);
    assert.doesNotMatch(line, /did not exist before install|restored byte for byte/, `${which}: no restore is claimed`);
    assert.equal(existsSync(pointer), false, `${which}: the install record is retired`);
  }
});

test('[LIFE-015] a foreign interrupted install record refuses uninstall before any change', () => {
  const w = world();
  const config = join(w.codexHome, 'config.toml');
  writeFileSync(config, '# my codex config\n');
  assert.equal(w.ce(['install']).status, 0);
  assert.equal(w.ce(['enable']).status, 0);
  const pointer = join(w.stateDir, 'setup', 'codex.json');
  const pending = join(w.stateDir, 'setup', 'codex.pending.json');
  writeFileSync(pending, JSON.stringify({ version: 1, kind: 'codex', dir: join(tempDir('elsewhere'), 'codex-x'), files: [], namespaced: [], watch: [], listing: [] }), { mode: 0o600 });
  const installed = tree(w.codexHome), project = tree(w.project), projects = tree(join(w.stateDir, 'setup', 'projects'));

  for (const attempt of [1, 2]) {
    const r = w.ce(['uninstall']);
    assert.notEqual(r.status, 0, `uninstall ${attempt} refuses a record it cannot verify. It said:\n${r.stdout}`);
    assert.ok(r.stderr.includes(pending), `uninstall ${attempt} names ${pending}:\n${r.stderr}`);
    assert.deepEqual(tree(w.codexHome), installed, `uninstall ${attempt} left config.toml and the plugin alone`);
    assert.deepEqual(tree(w.project), project, `uninstall ${attempt} left the project settings alone`);
    assert.deepEqual(tree(join(w.stateDir, 'setup', 'projects')), projects, `uninstall ${attempt} left the project records alone`);
    assert.ok(existsSync(pointer), 'the install record stays');
    assert.match(r.stderr, /move the record aside/, `uninstall ${attempt} gives a next step:\n${r.stderr}`);
  }

  rmSync(pending);
  const r = w.ce(['uninstall']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(readFileSync(config, 'utf8'), '# my codex config\n');
});

for (const forge of ['snapshot outside the backups directory', 'tracked file outside the runner policy']) {
  test(`[LIFE-015] an interrupted install record naming a ${forge} is refused before any change`, async () => {
    const w = world();
    const tracked = join(w.codexHome, 'config.toml');
    writeFileSync(tracked, '# my codex config\n');
    const pause = join(tempDir('pause'), 'plugin-add');
    const install = startSetup(['install'], { cwd: w.project, env: { ...w.env, FAKE_CODEX_PAUSE: pause } });
    try { await waitForFile(pause); } finally { killGroup(install.pid); }
    assert.equal((await install.done).signal, 'SIGKILL');
    rmSync(join(w.stateDir, 'setup', 'codex.setup.lock'));
    const pending = join(w.stateDir, 'setup', 'codex.pending.json');
    const record = JSON.parse(readFileSync(pending, 'utf8')) as { dir: string; files: Array<{ path: string; before: string | null }> };
    if (forge.startsWith('snapshot')) {
      // A private snapshot with copies that would pass every later check, but outside setup/backups.
      const forged = join(tempDir('outside'), 'codex-forged');
      mkdirSync(join(forged, 'before'), { recursive: true, mode: 0o700 });
      record.files = record.files.map((f) => {
        if (f.before === null) return f;
        const copy = join(forged, 'before', basename(f.before));
        writeFileSync(copy, 'model = \"forged\"\n', { mode: 0o600 });
        return { ...f, before: copy };
      });
      record.dir = forged;
    } else {
      const victim = join(w.home, 'victim.json');
      writeFileSync(victim, '{"keep": true}\n');
      record.files[0]!.path = victim;
    }
    writeFileSync(pending, JSON.stringify(record));
    const afterKill = readFileSync(tracked, 'utf8');

    const r = w.ce(['uninstall']);
    assert.notEqual(r.status, 0, `${forge}: uninstall refuses the record. It said:\n${r.stdout}`);
    assert.ok(r.stderr.includes(pending) && r.stderr.includes('violates confinement policy'), `${forge}: the refusal names the record and the policy:\n${r.stderr}`);
    assert.equal(readFileSync(tracked, 'utf8'), afterKill, `${forge}: config.toml is unchanged`);
    assert.ok(existsSync(pending), `${forge}: the record stays`);
  });
}

test('[SAFE-011] a hard-linked backup copy refuses uninstall before any runner command or change', () => {
  const w = world();
  writeFileSync(join(w.codexHome, 'config.toml'), '# my codex config\n');
  assert.equal(w.ce(['install']).status, 0);
  assert.equal(w.ce(['enable']).status, 0);
  const pointer = join(w.stateDir, 'setup', 'codex.json');
  const copy = join(snapshotOf(pointer), 'before', '0-config.toml');
  linkSync(copy, join(tempDir('second-link'), 'copy'));
  const installed = tree(w.codexHome), project = tree(w.project);

  const r = w.ce(['uninstall']);
  assert.notEqual(r.status, 0, `uninstall refuses a linked backup copy. It said:\n${r.stdout}`);
  assert.ok(r.stderr.includes(copy), `the refusal names ${copy}:\n${r.stderr}`);
  assert.deepEqual(tree(w.codexHome), installed, 'no runner command ran and no tracked file changed');
  assert.deepEqual(tree(w.project), project, 'no project setting was reverted');
  assert.ok(existsSync(pointer), 'the install record stays');
});

test('[LIFE-015] without its before backup the undo keeps every value it did not write and lists it', async () => {
  const w = world();
  const config = join(w.codexHome, 'config.toml');
  // The user's own table at a Context Engine table name, which the killed install never wrote.
  const own = '[plugins."context-engine@context-engine"]\nenabled = false\n';
  writeFileSync(config, `# my codex config\n${own}`);
  const pause = join(tempDir('pause'), 'plugin-add');
  const install = startSetup(['install'], { cwd: w.project, env: { ...w.env, FAKE_CODEX_PAUSE: pause } });
  try { await waitForFile(pause); } finally { killGroup(install.pid); }
  assert.equal((await install.done).signal, 'SIGKILL');
  rmSync(join(w.stateDir, 'setup', 'codex.setup.lock'));
  const pending = join(w.stateDir, 'setup', 'codex.pending.json');
  assert.match(readFileSync(config, 'utf8'), /\[marketplaces\.context-engine\]/, 'the kill left the marketplace table the install wrote');
  unlinkSync(join(snapshotOf(pending), 'before', '0-config.toml'));

  const r = w.ce(['uninstall']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const now = readFileSync(config, 'utf8');
  assert.ok(now.includes(own), `the user's table stays:\n${now}`);
  assert.doesNotMatch(now, /\[marketplaces\.context-engine\]/, 'the table the install wrote is gone');
  assert.ok(r.stdout.includes(`${config}: [plugins."context-engine@context-engine"] left in place because the backup copy is missing`), r.stdout);
  assert.doesNotMatch(r.stdout, /Only Context Engine's entries were removed/, 'the report claims no more than it did');
});
