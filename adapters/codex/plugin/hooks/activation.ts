// Cache-local opt-in proof: no checkout imports, writes, runner calls, or credentials.
// Keep the record format and nearest-project lookup aligned with core/participation.ts.
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

export function locallyEnabled(project: string): boolean {
  if (new Set(['off', '0', 'false', 'no', 'disable', 'disabled']).has((process.env.CONTEXT_ENGINE ?? '').trim().toLowerCase())) return false;
  const override = process.env.CONTEXT_ENGINE_STATE_DIR;
  if (override && !isAbsolute(override)) throw new Error('CONTEXT_ENGINE_STATE_DIR must be absolute');
  const xdg = process.env.XDG_STATE_HOME;
  const root = override || join(xdg && isAbsolute(xdg) ? xdg : join(homedir(), '.local', 'state'), 'context-engine');
  const directory = join(root, 'participation');
  const fds: number[] = [];
  try {
    for (const path of [root, directory]) {
      let fd: number;
      try { fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; }
      fds.push(fd);
      const st = fstatSync(fd);
      if (!st.isDirectory() || (st.mode & 0o077) !== 0 || (process.getuid && st.uid !== process.getuid()) || realpathSync(`/proc/self/fd/${fd}`) !== resolve(path)) throw new Error('unverified participation directory');
    }
    const dirFd = fds[1];
    for (let dir = realpathSync(project); ; dir = dirname(dir)) {
      const raw = basename(dir).replace(/[^\w.-]/g, '_') || 'root';
      const prefix = raw.length <= 190 ? raw : raw.slice(0, 128);
      const digest = createHash('sha256').update(dir).digest('hex');
      let key = `${prefix}-${digest}`;
      if (key.length > 250) key = `${key.slice(0, 128)}-${digest}`;
      const name = `${key}.json`;
      let fd: number | undefined;
      try {
        try { fd = openSync(join(`/proc/self/fd/${dirFd}`, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
        if (fd !== undefined) {
          const st = fstatSync(fd);
          if (!st.isFile() || st.nlink !== 1 || st.size > 16384 || (st.mode & 0o077) !== 0 || (process.getuid && st.uid !== process.getuid()) || realpathSync(`/proc/self/fd/${fd}`) !== join(directory, name)) throw new Error('unverified participation record');
          const buffer = Buffer.alloc(16385);
          let used = 0;
          while (used < buffer.length) { const n = readSync(fd, buffer, used, buffer.length - used, used); if (!n) break; used += n; }
          if (used > 16384) throw new Error('participation record exceeds read limit');
          let record: { projectRoot?: unknown; state?: unknown } | undefined;
          try { record = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, used))); } catch {}
          if (record?.projectRoot === dir && (record.state === 'on' || record.state === 'off')) {
            // Uninstall retires only this adapter's known opt-in; shared participation stays intact.
            const pointer = join(root,'setup','projects',name);
            let retiredFd: number | undefined;
            try {
              try { retiredFd=openSync(pointer,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK); }
              catch(e) {if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
              if(retiredFd!==undefined) {
                const st=fstatSync(retiredFd);
                if(!st.isFile()||st.nlink!==1||st.size>16384||(st.mode&0o077)!==0||(process.getuid&&st.uid!==process.getuid())||realpathSync(`/proc/self/fd/${retiredFd}`)!==pointer)throw new Error('unverified Codex project opt-in');
                const bytes=Buffer.alloc(st.size+1),n=readSync(retiredFd,bytes,0,bytes.length,0);
                if(n!==st.size)throw new Error('changed Codex project opt-in');
                const row=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,n)));
                if(row.projectRoot!==dir)throw new Error('Codex project opt-in identity mismatch');
                if(Object.hasOwn(row,'retired')&&typeof row.retired!=='boolean')throw new Error('invalid Codex retirement state');
                if(row.retired===true)return false;
              }
            } finally {if(retiredFd!==undefined)closeSync(retiredFd);}
            return record.state === 'on';
          }
          return false;
        }
      } finally { if (fd !== undefined) closeSync(fd); }
      if (dirname(dir) === dir) return false;
    }
  } finally { for (const fd of fds.reverse()) closeSync(fd); }
}
