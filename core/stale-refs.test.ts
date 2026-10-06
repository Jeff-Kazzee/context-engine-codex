import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cite, MAX_STALE_LISTED, openSession, type Session } from './index.ts';
import { fixture } from './testing.ts';

type Fixture = ReturnType<typeof fixture>;

function open(f: Fixture, experiments: string[] = ['stale-refs']): Session {
  const r = openSession({ ...f, sessionId: 'S1', runner: 'test', hardLimit: 10_000, experiments });
  assert.equal(r.status, 'open');
  return r.session;
}

const lines = (n: number, tag = 'line') => Array.from({ length: n }, (_, i) => `${tag} ${i + 1}`).join('\n') + '\n';

/** Writes the Working Context with the given notes and commits it. */
function note(s: Session, text: string) {
  writeFileSync(s.workingContextPath, `[[CTX_TURN 1 role=user]]\n${text}\n`);
  return s.sync();
}

test('a cited span whose lines were edited is listed as stale at sync', () => {
  const f = fixture();
  writeFileSync(join(f.projectRoot, 'a.ts'), lines(20));
  const marker = cite(f.projectRoot, 'a.ts#L5-7');
  assert.match(marker, /^⟦src:a\.ts#L5-7@[0-9a-f]{8}⟧$/);
  const s = open(f);
  assert.equal(note(s, `parser lives at ${marker}`).receipt?.stale, undefined, 'fresh citation is not stale');

  writeFileSync(join(f.projectRoot, 'a.ts'), lines(20).replace('line 6\n', 'line six\n'));
  const r = s.sync();
  assert.equal(r.receipt?.kind, 'stale');
  assert.deepEqual(r.receipt?.stale, { count: 1, refs: [{ marker, reason: 'changed' }] });
  assert.match(r.receipt!.text, /1 cited reference is stale/);
  assert.ok(r.receipt!.text.includes(marker));
  assert.equal(r.chars, 66);
  assert.equal(r.receipt?.approxTokens, 17, 'stale receipts carry the size readout too');
  assert.match(r.receipt!.text, /~17 tokens \(approx/);
});

test('a span whose lines shifted is listed as moved, with where it is now', () => {
  const f = fixture();
  const file = join(f.projectRoot, 'src', 'b.ts');
  mkdirSync(join(f.projectRoot, 'src'));
  writeFileSync(file, lines(20));
  const marker = cite(f.projectRoot, 'src/b.ts#L5-7');
  const s = open(f);
  note(s, marker);

  writeFileSync(file, lines(20).replace('line 15\n', 'line fifteen\n'));
  assert.equal(s.sync().receipt, undefined, 'an edit outside the span leaves it fresh');

  writeFileSync(file, 'import x;\nimport y;\n' + lines(20));
  assert.deepEqual(s.sync().receipt?.stale, { count: 1, refs: [{ marker, reason: 'moved', to: 'L7-9' }] });
  assert.match(s.sync().receipt!.text, /\(moved to L7-9\)/);
});

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

test('a cited commit that was rewritten or never existed is listed; one still in history is not', () => {
  const f = fixture();
  git(f.projectRoot, 'init', '-q');
  writeFileSync(join(f.projectRoot, 'a.ts'), 'one\n');
  git(f.projectRoot, 'add', '.');
  git(f.projectRoot, 'commit', '-q', '-m', 'first');
  const kept = cite(f.projectRoot, 'commit:HEAD');
  assert.match(kept, /^⟦commit:[0-9a-f]{12}⟧$/);
  git(f.projectRoot, 'commit', '-q', '--allow-empty', '-m', 'second');
  const amended = cite(f.projectRoot, 'commit:HEAD');
  const bogus = '⟦commit:0123456789ab⟧';
  const s = open(f);
  note(s, `${kept} ${amended} ${bogus}`);
  const before = s.sync().receipt?.stale;
  assert.deepEqual(before, { count: 1, refs: [{ marker: bogus, reason: 'missing' }] });

  git(f.projectRoot, 'commit', '-q', '--amend', '--allow-empty', '-m', 'second, reworded');
  assert.deepEqual(s.sync().receipt?.stale, {
    count: 2,
    refs: [
      { marker: amended, reason: 'rewritten' },
      { marker: bogus, reason: 'missing' },
    ],
  });
});

test('commit markers are not checked outside a git repository', () => {
  const f = fixture();
  const s = open(f);
  note(s, 'see ⟦commit:0123456789ab⟧');
  assert.equal(s.sync().receipt, undefined);
});

test('flag off: stale markers are ignored and receipts are unchanged', () => {
  const f = fixture();
  const s = open(f, []);
  s.record([{ role: 'user', text: 'Task.' }]);
  const r = note(s, 'see ⟦src:nope.ts@01234567⟧ and ⟦commit:0123456789ab⟧');
  assert.equal(r.receipt?.kind, 'committed');
  assert.equal(r.receipt?.stale, undefined);
  assert.doesNotMatch(r.receipt!.text, /stale/);
  assert.equal(s.sync().receipt, undefined);
  assert.equal(s.record([{ role: 'user', text: 'more' }]).receipt, undefined);
});

test('the flag comes from $CONTEXT_ENGINE_EXPERIMENTS when no option is given', () => {
  const f = fixture();
  const saved = process.env.CONTEXT_ENGINE_EXPERIMENTS;
  try {
    delete process.env.CONTEXT_ENGINE_EXPERIMENTS;
    const off = openSession({ ...f, sessionId: 'off', runner: 'test', hardLimit: 10_000 });
    assert.equal(off.status, 'open');
    assert.equal(note(off.session, '⟦src:nope.ts@01234567⟧').receipt?.stale, undefined);

    process.env.CONTEXT_ENGINE_EXPERIMENTS = 'other, stale-refs';
    const on = openSession({ ...f, sessionId: 'on', runner: 'test', hardLimit: 10_000 });
    assert.equal(on.status, 'open');
    assert.equal(note(on.session, '⟦src:nope.ts@01234567⟧').receipt?.stale?.count, 1);
  } finally {
    if (saved === undefined) delete process.env.CONTEXT_ENGINE_EXPERIMENTS;
    else process.env.CONTEXT_ENGINE_EXPERIMENTS = saved;
  }
});

test(`the receipt lists at most ${MAX_STALE_LISTED} stale markers plus the total, after the commit notice`, () => {
  const f = fixture();
  const s = open(f);
  const markers = Array.from({ length: 7 }, (_, i) => `⟦src:gone${i}.ts@0123456${i}⟧`);
  s.record([{ role: 'user', text: 'Task.' }]);
  const r = note(s, [...markers, markers[0]].join('\n'));
  assert.equal(r.receipt?.kind, 'committed');
  assert.equal(r.receipt?.stale?.count, 7, 'duplicates count once');
  assert.deepEqual(
    r.receipt?.stale?.refs.map((x) => x.marker),
    markers.slice(0, MAX_STALE_LISTED),
  );
  assert.match(r.receipt!.text, /^Context Engine: Working Context edit committed as revision 2.*\nContext Engine: 7 cited references are stale: .*, and 2 more\./);
});

test('runner appends are checked too, and markers escaping the project are not markers', () => {
  const f = fixture();
  const s = open(f);
  const r = s.record([{ role: 'tool', text: 'old note ⟦src:gone.ts@01234567⟧ ⟦src:../outside.ts@01234567⟧' }]);
  assert.deepEqual(r.receipt?.stale, { count: 1, refs: [{ marker: '⟦src:gone.ts@01234567⟧', reason: 'missing' }] });
});

test('cite refuses paths outside the project and line ranges past the end', () => {
  const f = fixture();
  writeFileSync(join(f.projectRoot, 'a.ts'), lines(3));
  assert.throws(() => cite(f.projectRoot, '../x.ts'), /not inside the project/);
  assert.throws(() => cite(f.projectRoot, 'a.ts#L3-9'), /no lines 3-9/);
  assert.match(cite(f.projectRoot, join(f.projectRoot, 'a.ts#L2')), /^⟦src:a\.ts#L2@[0-9a-f]{8}⟧$/);
});

test('a cited file that was deleted is listed as missing', () => {
  const f = fixture();
  writeFileSync(join(f.projectRoot, 'gone.ts'), 'export {};\n');
  const marker = cite(f.projectRoot, 'gone.ts');
  assert.match(marker, /^⟦src:gone\.ts@[0-9a-f]{8}⟧$/);
  const s = open(f);
  note(s, `see ${marker}`);
  rmSync(join(f.projectRoot, 'gone.ts'));
  assert.deepEqual(s.sync().receipt?.stale, { count: 1, refs: [{ marker, reason: 'missing' }] });
});
