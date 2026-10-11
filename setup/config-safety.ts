import { extname } from 'node:path';

/** Inspect configuration structure only; diagnostics never contain values. This is not a universal secret detector. */
export function assertBackupSafe(path: string, bytes: Buffer | null): void {
  if(bytes===null)return;
  const format=extname(path).toLowerCase();if(!['.json','.toml'].includes(format))return;
  const refuse=()=>{throw new Error(`credential-bearing or unsafe configuration cannot be backed up: ${path}`);};
  // A file setup cannot parse holds no known credential, so its refusal says what failed instead.
  const unreadable=(format:string)=>{throw new Error(`setup cannot read ${path} as ${format}, so it refuses to back it up or change it`);};
  let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{unreadable('UTF-8 text');return;}
  const sensitive=(key:string)=>{
    const n=key.toLowerCase().replace(/[^a-z0-9]/g,'');
    return /(apikey|accesskey|secretkey|clientsecret|secret|password|privatekey|authorization|credentials?)$/.test(n) || n.endsWith('token') || n==='tokens' || n==='auth' || n==='bearer' || n==='cookie' || n==='setcookie';
  };
  if(format==='.json'){
    let value:unknown;try{value=JSON.parse(text);}catch{unreadable('JSON');return;}
    const walk=(v:unknown):void=>{if(!v||typeof v!=='object')return;for(const [key,item] of Object.entries(v)){if(sensitive(key)&&item!==null&&item!==''&&item!==undefined)refuse();walk(item);}};
    walk(value);return;
  }
  // Only plain table/assignment syntax is accepted for TOML backup inspection.
  // Escaped keys and inline tables are ambiguous to this bounded key scanner.
  // A Codex trust table such as [projects."/abs/path"] names a project directory, not a credential.
  const projectTable=(raw:string)=>/^\s*projects\s*\.\s*(?:"\/[^"\\\r\n]*"|'\/[^'\r\n]*')\s*$/.test(raw);
  let triple:string|null=null;
  const checkKey=(raw:string)=>{
    const bare=raw.replace(/"[^"\\\r\n]*"|'[^'\r\n]*'/g,'KEY');
    if(raw.includes('\\') || /[^A-Za-z0-9_\-. \t]/.test(bare) || sensitive(raw))refuse();
    for(const part of raw.split('.')){const key=part.trim().replace(/^['"]|['"]$/g,'');if(sensitive(key)||['env','headers','httpheaders'].includes(key.toLowerCase().replace(/[^a-z0-9]/g,'')))refuse();}
  };
  const scan=(line:string,start:number)=>{
    let quote:string|null=null;
    for(let i=start;i<line.length;i++){
      if(triple){if(line.startsWith(triple,i)){const q=triple[0];while(line[i]===q)i++;i--;triple=null;}else if(triple==='"""'&&line[i]==='\\')i++;continue;}
      if(quote){if(quote==='"'&&line[i]==='\\')i++;else if(line[i]===quote)quote=null;continue;}
      if(line[i]==='#')return;
      if(line.startsWith('"""',i)||line.startsWith("'''",i)){triple=line.slice(i,i+3);i+=2;continue;}
      if(line[i]==='"'||line[i]==="'"){quote=line[i]!;continue;}
      if(line[i]==='{'||line[i]==='}')refuse();
    }
    if(quote)refuse();
  };
  for(const line of text.split(/\r?\n/)){
    if(triple){scan(line,0);continue;}
    const trimmed=line.trim();if(!trimmed||trimmed.startsWith('#'))continue;
    if(trimmed.startsWith('[')){const header=trimmed.match(/^\[{1,2}(.+?)\]{1,2}\s*(?:#.*)?$/);if(!header)refuse();else if(!projectTable(header[1]!))checkKey(header[1]!);continue;}
    let quote:string|null=null,equals=-1;
    for(let i=0;i<line.length;i++){const c=line[i];if(quote){if(c==='\\')refuse();if(c===quote)quote=null;}else if(c==='"'||c==="'")quote=c;else if(c==='='){equals=i;break;}else if(c==='#')break;}
    if(equals<0||quote)refuse();checkKey(line.slice(0,equals));scan(line,equals+1);
  }
  if(triple)refuse();
}
