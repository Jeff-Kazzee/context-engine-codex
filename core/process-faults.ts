// INTERNAL test preload, private to the core's own tests. Not exported from index.ts.
//
// `node --import <this file> core/cli.ts ...` with CE_TEST_FAULT set to a JSON FaultPlan stops a
// real process at one filesystem call: it sends itself SIGKILL there, or blocks until the test
// releases it. Unlike the in-process seam in faults.ts, a kill runs no finally block, releases no
// lock or lease and closes no descriptor, exactly like a crash. Nothing is patched when the
// variable is unset.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

export interface FaultPlan {
  call: 'openSync' | 'writeSync' | 'writeFileSync' | 'fsyncSync' | 'renameSync' | 'linkSync';
  /** Regular expression for the resolved absolute path: the opened, written or flushed file, or the destination of a rename or link. */
  path: string;
  /** writeSync: the written bytes contain this text. fsyncSync: a matching earlier write contained it. */
  contains?: string;
  /** Before the call, after it returns, or (writeSync only) after writing the first half of its bytes. */
  at: 'before' | 'after' | 'half';
  /** kill: SIGKILL this process. block: create `<dir>/blocked`, wait for `<dir>/release`, and self-kill after 60 s. */
  action: 'kill' | 'block';
  dir?: string;
}

const raw = process.env.CE_TEST_FAULT;
if (raw) install(JSON.parse(raw) as FaultPlan);

function install(plan: FaultPlan): void {
  const fsx = fs as unknown as Record<string, (...args: any[]) => any>;
  const native = { ...fsx };
  const pattern = new RegExp(plan.path);
  const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  let fired = false;
  // An fsync plan with `contains` waits for a matching write first.
  let primed = !(plan.call === 'fsyncSync' && plan.contains !== undefined);

  const resolved = (target: unknown): string => {
    try {
      if (typeof target === 'number') return native.readlinkSync!(`/proc/self/fd/${target}`);
      const name = String(target), m = /^\/proc\/self\/fd\/(\d+)(\/.*)?$/.exec(name);
      return m ? native.readlinkSync!(`/proc/self/fd/${m[1]}`) + (m[2] ?? '') : name;
    } catch { return ''; }
  };
  const act = (): void => {
    fired = true;
    if (plan.action === 'kill') for (;;) { process.kill(process.pid, 'SIGKILL'); sleep(1000); }
    native.writeFileSync!(`${plan.dir}/blocked`, String(process.pid));
    const deadline = Date.now() + 60_000;
    while (!native.existsSync!(`${plan.dir}/release`)) {
      if (Date.now() > deadline) process.kill(process.pid, 'SIGKILL');
      sleep(5);
    }
  };
  const around = (call: FaultPlan['call'], hit: (args: any[]) => boolean) => {
    fsx[call] = (...args: any[]) => {
      if (fired || !primed || plan.call !== call || !hit(args)) return native[call]!(...args);
      if (plan.at === 'before') act();
      const result = native[call]!(...args);
      if (plan.at === 'after') act();
      return result;
    };
  };

  around('openSync', ([path]) => pattern.test(resolved(path)));
  around('writeFileSync', ([path]) => pattern.test(resolved(path)));
  around('fsyncSync', ([fd]) => pattern.test(resolved(fd)));
  around('renameSync', ([, to]) => pattern.test(resolved(to)));
  around('linkSync', ([, to]) => pattern.test(resolved(to)));
  fsx.writeSync = (fd: number, data: any, ...rest: any[]) => {
    const pass = () => native.writeSync!(fd, data, ...rest);
    if (fired || typeof data === 'string' || (plan.call !== 'writeSync' && primed)) return pass();
    const [offset = 0, length = data.byteLength - offset] = rest as Array<number | undefined>;
    const bytes = Buffer.from(data.buffer, data.byteOffset + offset, length);
    if (!pattern.test(resolved(fd)) || (plan.contains !== undefined && !bytes.includes(plan.contains))) return pass();
    if (!primed) { primed = true; return pass(); }
    if (plan.at === 'before') act();
    if (plan.at === 'half') {
      const half = native.writeSync!(fd, bytes, 0, bytes.length >> 1, null);
      act();
      return half + native.writeSync!(fd, bytes, half, bytes.length - half, null);
    }
    const written = pass();
    if (plan.at === 'after') act();
    return written;
  };
  syncBuiltinESMExports();
}
