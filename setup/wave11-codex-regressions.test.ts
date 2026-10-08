import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { world } from './testing/world.ts';
import { setupContext } from './runners.ts';
import { enableProject, disableProject } from './project.ts';
import { participation } from '../core/index.ts';

test('wave11: malformed project ledger cannot publish off while active guidance remains',()=>{
  const w=world();assert.equal(w.ce(['install']).status,0);const ctx=setupContext(w.env);enableProject(ctx,w.project);
  const pointer=join(ctx.setupDir,'projects',fs.readdirSync(join(ctx.setupDir,'projects'))[0]!),dir=JSON.parse(fs.readFileSync(pointer,'utf8')).dir;
  fs.writeFileSync(join(dir,'ledger.json'),'{}');const config=join(w.project,'.codex/config.toml'),before=fs.readFileSync(config);
  assert.throws(()=>disableProject(ctx,w.project));assert.deepEqual(fs.readFileSync(config),before);
  assert.equal(participation({projectRoot:w.project,stateDir:w.stateDir,env:{}}).state,'on');
});

test('wave11: failed descendant masking preserves inherited participation',()=>{
  const w=world();assert.equal(w.ce(['install']).status,0);const ctx=setupContext(w.env);enableProject(ctx,w.project);
  const child=join(w.project,'child');fs.mkdirSync(child);fs.symlinkSync(w.project,join(child,'.codex'));
  assert.throws(()=>disableProject(ctx,child));assert.equal(participation({projectRoot:child,stateDir:w.stateDir,env:{}}).state,'on');
});
