import { assertSupportedNode } from '../../setup/node-runtime.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { openSession, inspectSession, recall, show, readWorkingContext } from '../../core/index.ts';
import { readConfined, readLog, projectKeyForCanonicalPath } from '../../core/store.ts';
import { requireVerifiedIntegration } from '../../setup/platform.ts';
assert.equal(process.platform, 'win32');
const fixture = resolve(process.argv[2]!);
assert.match(fixture, /\\windows-native-20261102\\fixtures$/);
const root = join(fixture, `core-${process.pid}-${Date.now()}`);
const project = join(root, 'project'), state = join(root, 'state');
mkdirSync(project, { recursive: true });
const ref = { projectRoot: project, stateDir: state, sessionId: 'Windows1' };
const options = { ...ref, runner: 'native-windows-acceptance', hardLimit: 100000 };
let opened = openSession(options);
assert.equal(opened.status, 'open');
if (opened.status !== 'open') throw new Error('session refused');
let session = opened.session;
const batch = [{ role: 'user' as const, text: 'Initial database decision: SQLite.' }];
const operationId = '3776f641-15cc-4b63-8139-cdf0f20bf752';
const edited = '# Working Context\n\nUse PostgreSQL. The earlier SQLite choice is superseded.\n';
try {
  await test('native session records once, commits an external edit and retains original evidence', () => {
    const first = session.record(batch, { operationId });
    const retry = session.record(batch, { operationId });
    assert.equal(retry.revision, first.revision);
    writeFileSync(session.workingContextPath, edited);
    const synced = session.sync();
    assert.equal(synced.workingContextText, edited);
    assert.equal(synced.receipt?.kind, 'committed');
    const hits = recall({ ...ref, query: 'SQLite' });
    assert.equal(hits.hits.length, 1); assert.equal(hits.hits[0]?.id, 'e1');
    assert.equal(show({ ...ref, id: 'e1' }).text, batch[0]!.text);
    const sum = createHash('sha256').update(edited).digest('hex');
    const read = readWorkingContext({ ...ref, sha: sum });
    assert.ok(JSON.stringify(read).includes('PostgreSQL'));
    const log = [...readLog(join(session.stateDir, 'events.jsonl'))];
    assert.equal(log.filter(row => row.type === 'runner-events').length, 1);
  });
  await test('native close and reopen preserve context and full identity-backed indexes', () => {
    session.close();
    opened = openSession(options); assert.equal(opened.status, 'open');
    if (opened.status !== 'open') throw new Error('reopen refused'); session = opened.session;
    assert.equal(session.sync().workingContextText, edited);
    assert.equal(recall({ ...ref, query: 'SQLite' }).hits.length, 1);
  });
  await test('invalid Working Context restores retained revision with notice evidence', () => {
    writeFileSync(session.workingContextPath, '');
    const restored = session.sync();
    assert.equal(restored.workingContextText, edited);
    assert.equal(restored.receipt?.kind, 'restored');
    assert.ok((restored.restoreNotices?.length ?? 0) > 0);
    assert.equal(readFileSync(session.workingContextPath, 'utf8'), edited);
  });
  await test('mixed-case project credential fixtures are refused before payload reads', () => {
    for (const name of ['.ENV', '.NPMRC']) {
      writeFileSync(join(project, name), 'synthetic private sentinel');
      assert.deepEqual(readConfined(project, name), { refused: 'credential' });
    }
    mkdirSync(join(project, '.SSH'));
    writeFileSync(join(project, '.SSH', 'sentinel'), 'synthetic private sentinel');
    assert.deepEqual(readConfined(project, '.SSH/sentinel'), { refused: 'credential' });
  });
  await test('recorded missing-project identities reject malformed UTF-16 before hashing', () => {
    const missing = join(root, 'missing');
    for (const name of ['a\ud800', 'a\udfff']) {
      const record = JSON.parse(JSON.stringify({ projectRoot: join(missing, name) }));
      assert.throws(() => projectKeyForCanonicalPath(record.projectRoot), /well-formed UTF-16/);
    }
    const valid = JSON.parse(JSON.stringify({ projectRoot: join(missing, 'evidence-\u00e9-\u{1f600}') }));
    assert.doesNotThrow(() => projectKeyForCanonicalPath(valid.projectRoot));
    assert.equal(existsSync(missing), false);
  });
  await test('Windows loader retains the fixed Node runtime policy', () => {
    for (const version of ['24.19.0', '24.21.0', '24.22.0', '24.22.1-rc.1', '25.0.0', '27.0.0', 'invalid']) {
      assert.throws(() => assertSupportedNode(version), { code: 'CE_UNSUPPORTED_NODE' });
    }
    assert.doesNotThrow(() => assertSupportedNode('24.22.1'));
    assert.doesNotThrow(() => assertSupportedNode('26.12.1'));
    assertSupportedNode();
  });
  await test('unverified native plugin integration still refuses', () => {
    assert.throws(() => requireVerifiedIntegration(), { code: 'CE_WINDOWS_INTEGRATION_UNVERIFIED' });
  });
} finally { session.close(); }
assert.equal(inspectSession(ref).lock, null);
console.log(JSON.stringify({ fixture: root, fixturesRetained: true, profileTrial: false, paidModelCalls: 0 }));
