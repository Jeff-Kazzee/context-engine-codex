import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {join} from 'node:path';
import {world} from './testing/world.ts';
import {setupContext} from './runners.ts';
import {enableProject} from './project.ts';

test('wave26: successful and no-op enables retain no rollback-only publication snapshot',()=>{
 const w=world();{const r=w.ce(['install','--codex']);assert.equal(r.status,0,r.stderr+r.stdout);};for(let i=0;i<2;i++)assert.equal(w.ce(['enable']).status,0);
 const backups=fs.readdirSync(join(w.stateDir,'setup','backups'));assert.equal(backups.filter(name=>name.startsWith('enable-publication-')).length,0);assert.ok(backups.some(name=>name.startsWith('project-')));
});

for(const existed of [true,false])test('wave26: project publication retains a concurrent '+(existed?'edit':'creation'),()=>{
 const w=world();{const r=w.ce(['install','--codex']);assert.equal(r.status,0,r.stderr+r.stdout);};const config=join(w.project,'.codex','config.toml');fs.mkdirSync(join(w.project,'.codex'),{recursive:true});if(existed)fs.writeFileSync(config,'model = "before"\n');
 const native=fs.openSync;let reads=0,changed=false;
 fs.openSync=((path:any,flags:any,...args:any[])=>{if(String(path)===config&&typeof flags==='number'&&!(flags&fs.constants.O_WRONLY)&&++reads===4){changed=true;fs.writeFileSync(config,'model = "latest-concurrent"\n');}return(native as any)(path,flags,...args);}) as typeof fs.openSync;syncBuiltinESMExports();
 try{assert.throws(()=>enableProject(setupContext(w.env),w.project),/changed|rolled back|exist|publication|activation/);}finally{fs.openSync=native;syncBuiltinESMExports();}
 assert.equal(changed,true);assert.equal(fs.readFileSync(config,'utf8'),'model = "latest-concurrent"\n');
});
