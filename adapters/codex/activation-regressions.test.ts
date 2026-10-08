import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {fixture} from '../../core/testing.ts';
import {projectKey} from '../../core/store.ts';
import {setParticipation} from '../../core/index.ts';
test('renewed: cache-local corrupt opt-out refuses before checkout import',async()=>{
 const {locallyEnabled}=await import('./plugin/hooks/activation.ts');
 const f=fixture(),child=join(f.projectRoot,'child');fs.mkdirSync(child);setParticipation({...f,state:'on'});setParticipation({...f,projectRoot:child,state:'off'});
 fs.writeFileSync(join(f.stateDir,'participation',projectKey(child)+'.json'),'{broken');
 const previous=process.env.CONTEXT_ENGINE_STATE_DIR;process.env.CONTEXT_ENGINE_STATE_DIR=f.stateDir;
 try{assert.equal(locallyEnabled(child),false);}finally{if(previous===undefined)delete process.env.CONTEXT_ENGINE_STATE_DIR;else process.env.CONTEXT_ENGINE_STATE_DIR=previous;}
});
