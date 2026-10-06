import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { world } from './testing/world.ts';
import { takeSnapshot } from './ledger.ts';
import { assertBackupSafe } from './config-safety.ts';
test('late review: all preflight completes before any before-copy',()=>{
 const w=world(),first=join(w.claudeHome,'first.json'),second=join(w.claudeHome,'second.json'),backupRoot=join(w.stateDir,'backups');fs.writeFileSync(first,'{"theme":"dark"}');fs.writeFileSync(second,'{"password":"SYNTHETIC_ONLY"}');assert.throws(()=>takeSnapshot({backupRoot,kind:'synthetic',files:[first,second],watch:[],namespaced:[]}));assert.equal(fs.existsSync(backupRoot),false);
});
for(const text of ['[plugins."context-engine@context-engine"]\nenabled=true\n','[features.token_budget]\nguidance="Use the file"\n','description="""\nwords about authorization\n"""\n'])test('late review: benign TOML backup structure '+JSON.stringify(text),()=>assert.doesNotThrow(()=>assertBackupSafe('config.toml',Buffer.from(text))));
for(const text of ['[env]\nKEY="SYNTHETIC_ONLY"\n','[provider."http_headers"]\nother="SYNTHETIC_ONLY"\n','"api\\u005fkey"="SYNTHETIC_ONLY"\n'])test('late review: unsafe TOML backup structure refuses '+JSON.stringify(text.split('\n')[0]),()=>assert.throws(()=>assertBackupSafe('config.toml',Buffer.from(text))));
test('late review: configured auth helper reference is not an embedded secret',()=>assert.doesNotThrow(()=>assertBackupSafe('settings.json',Buffer.from('{"apiKeyHelper":"command-name"}'))));
test('late review: project path containing secret is not a credential key',()=>assert.doesNotThrow(()=>assertBackupSafe('config.toml',Buffer.from('[projects."/tmp/secret-project"]\ntrust_level="untrusted"\n'))));