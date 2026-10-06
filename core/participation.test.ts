// Participation: whether Context Engine is active for a project (per-project enable/disable, the
// opt-in rollout default, and the CONTEXT_ENGINE kill switch). Temp dirs only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { killSwitchOn, participation, setParticipation } from './index.ts';
import { fixture, tempDir } from './testing.ts';

const on = {};

test('a project nobody enabled is inactive: the pilot is opt-in', () => {
  const f = fixture();
  const p = participation({ ...f, env: on });
  assert.equal(p.active, false);
  assert.equal(p.state, 'default');
  assert.match(p.reason, /context-engine enable/);
});

test('enable makes a project active, including its subdirectories; disable turns it off again', () => {
  const f = fixture();
  setParticipation({ ...f, state: 'on' });
  assert.equal(participation({ ...f, env: on }).active, true);
  const sub = join(f.projectRoot, 'src', 'deep');
  mkdirSync(sub, { recursive: true });
  const inSub = participation({ ...f, projectRoot: sub, env: on });
  assert.equal(inSub.active, true);
  assert.equal(inSub.project, f.projectRoot);

  setParticipation({ ...f, state: 'off' });
  const off = participation({ ...f, env: on });
  assert.equal(off.active, false);
  assert.equal(off.state, 'off');
});

test('the nearest record wins: a subdirectory can opt out of an enabled project', () => {
  const f = fixture();
  const sub = join(f.projectRoot, 'vendor');
  mkdirSync(sub);
  setParticipation({ ...f, state: 'on' });
  setParticipation({ ...f, projectRoot: sub, state: 'off' });
  assert.equal(participation({ ...f, projectRoot: sub, env: on }).active, false);
  assert.equal(participation({ ...f, env: on }).active, true);
});

test('enabling one project does not enable another', () => {
  const f = fixture();
  setParticipation({ ...f, state: 'on' });
  assert.equal(participation({ ...f, projectRoot: tempDir('other'), env: on }).active, false);
});

test('the kill switch CONTEXT_ENGINE=off turns an enabled project off without touching its record', () => {
  const f = fixture();
  setParticipation({ ...f, state: 'on' });
  for (const value of ['off', 'OFF', '0', 'false', 'disabled']) {
    const p = participation({ ...f, env: { CONTEXT_ENGINE: value } });
    assert.equal(p.active, false, value);
    assert.equal(p.killSwitch, true);
    assert.match(p.reason, /CONTEXT_ENGINE=/);
    assert.equal(killSwitchOn({ CONTEXT_ENGINE: value }), true);
  }
  for (const value of ['', 'on', '1']) assert.equal(participation({ ...f, env: { CONTEXT_ENGINE: value } }).active, true, value);
  assert.equal(participation({ ...f, env: on }).active, true);
});
