import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { world } from './testing/world.ts';
import { setupContext } from './runners.ts';
import { enableProject } from './project.ts';
import { participation } from '../core/index.ts';

for(const text of ['features = false\n','features = []\n','"features" = false\n','[[features]]\nother = true\n'])test('wave13: incompatible features namespace refuses '+JSON.stringify(text),()=>{
  const w=world();assert.equal(w.ce(['install']).status,0);fs.mkdirSync(join(w.project,'.codex'));const config=join(w.project,'.codex/config.toml');fs.writeFileSync(config,text);
  assert.throws(()=>enableProject(setupContext(w.env),w.project),/features|token_budget|unsupported/);assert.equal(fs.readFileSync(config,'utf8'),text);assert.equal(participation({projectRoot:w.project,stateDir:w.stateDir,env:{}}).state,'off');
});
