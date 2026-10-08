import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tempDir } from '../core/testing.ts';
import { setupContext, type RunnerSpec } from './runners.ts';
import { installLocked } from './install.ts';
import { takeSnapshot, completeLedger, readLedger } from './ledger.ts';
import { jsonRule, tomlTablesRule } from './rules.ts';

for(const replacement of ['none','early','late'])test('wave11: failed install pointer flush '+replacement,()=>{
  const root=tempDir('install-flush'),ctx=setupContext({HOME:root,CONTEXT_ENGINE_STATE_DIR:join(root,'state')}),config=join(root,'settings.json');
  fs.writeFileSync(config,'{"theme":"original"}\n');
  const spec:RunnerSpec={id:'claude',title:'Synthetic',home:root,bin:'unused',files:[config],watch:[],namespaced:[],rules:{[config]:jsonRule([['owned']])},install:[],uninstall:[],prepare:()=>fs.writeFileSync(config,'{"theme":"original","owned":true}\n')};
  const pointer=join(ctx.setupDir,'claude.json'),native=fs.fsyncSync,unlink=fs.unlinkSync,rename=fs.renameSync;let failed=false,replaced=false;
  const replace=()=>{fs.writeFileSync(pointer,'{"dir":"/synthetic/unrelated-snapshot"}\n');replaced=true;};
  fs.fsyncSync=((fd:number)=>{if(!failed&&fs.fstatSync(fd).isDirectory()&&fs.realpathSync(`/proc/self/fd/${fd}`)===ctx.setupDir&&fs.existsSync(pointer)){failed=true;if(replacement==='early')replace();throw new Error('synthetic pointer flush failure');}native(fd);}) as typeof fs.fsyncSync;
  fs.unlinkSync=((path:any)=>{if(replacement==='late'&&failed&&!replaced&&String(path).endsWith('/claude.json'))replace();return unlink(path);}) as typeof fs.unlinkSync;
  fs.renameSync=((from:any,to:any)=>{if(replacement==='late'&&failed&&!replaced&&String(from).endsWith('/claude.json'))replace();return rename(from,to);}) as typeof fs.renameSync;
  syncBuiltinESMExports();
  try {assert.throws(()=>installLocked(ctx,spec),/synthetic pointer flush failure/);}
  finally {fs.fsyncSync=native;fs.unlinkSync=unlink;fs.renameSync=rename;syncBuiltinESMExports();}
  assert.equal(failed,true);assert.equal(fs.existsSync(pointer),replacement!=='none');assert.deepEqual(JSON.parse(fs.readFileSync(config,'utf8')),{theme:'original'});
  if(replacement!=='none'){assert.equal(replaced,true);assert.equal(JSON.parse(fs.readFileSync(pointer,'utf8')).dir,'/synthetic/unrelated-snapshot');}
});

test('wave11: ledger refuses backup bytes from a sibling snapshot',()=>{
  const root=tempDir('ledger-snapshot'),file=join(root,'settings.json'),backupRoot=join(root,'backups');fs.writeFileSync(file,'{"theme":"original"}');
  const make=()=>completeLedger(takeSnapshot({backupRoot,kind:'synthetic',files:[file],watch:[],namespaced:[]}));
  const a=make(),b=make();a.files[0]!.before=b.files[0]!.before;
  fs.writeFileSync(join(a.dir,'ledger.json'),JSON.stringify(a));
  assert.throws(()=>readLedger(a.dir,{backupRoot,files:[file],namespaced:[]}),/policy|confined|invalid/);
  assert.equal(fs.readFileSync(file,'utf8'),'{"theme":"original"}');
});

for(const delimiter of ['"""',"'''"])test('wave11: TOML owned-looking multiline string content is preserved '+delimiter,()=>{
  const rule=tomlTablesRule(/^\[plugins\."owned"\]$/,/^\[plugins\]$/);
  const unmanaged=`instructions = ${delimiter}\n[plugins."owned"]\nKEEP STRING CONTENT\n${delimiter}\nother = "keep"\n`;
  const text=unmanaged+'\n[plugins."owned"]\nenabled = true\n\n[other]\nvalue = "keep"\n';
  const stripped=rule.strip(text,null);
  assert.ok(stripped.startsWith(unmanaged));assert.match(stripped,/\[other\]\nvalue = "keep"/);assert.equal(stripped.includes('enabled = true'),false);
});
