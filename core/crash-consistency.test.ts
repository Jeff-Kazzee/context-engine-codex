// Commit durability. A spy records the syscalls of one record() call. The order test checks that
// each publication flushes before it is made visible. The power-loss test replays the trace against
// a model in which only flushed bytes and flushed directory entries survive, and opens each image
// that model allows after one of the traced calls. It cannot show what a real filesystem keeps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { openSession, type Session } from './index.ts';
import { fixture } from './testing.ts';

type Call =
  | { op: 'open'; fd: number; path: string; created: boolean; directory: boolean }
  | { op: 'write'; fd: number; path: string; bytes: Buffer; positioned: boolean }
  | { op: 'fsync'; fd: number; path: string }
  | { op: 'rename' | 'link'; from: string; to: string }
  | { op: 'unlink' | 'truncate'; path: string };

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const count = (text: string, needle: string) => text.split(needle).length - 1;

/** Runs `fn` while recording the filesystem calls a commit makes, with every path resolved. */
function traced(fn: () => void): Call[] {
  const fsx = fs as unknown as Record<string, (...args: any[]) => any>;
  const native = { ...fsx };
  const calls: Call[] = [];
  const fdPath = (fd: number) => native.readlinkSync!(`/proc/self/fd/${fd}`) as string;
  const resolved = (p: unknown) => {
    const m = /^\/proc\/self\/fd\/(\d+)(\/.*)?$/.exec(String(p));
    return m ? fdPath(Number(m[1])) + (m[2] ?? '') : String(p);
  };
  fsx.openSync = (path: string, ...rest: any[]) => {
    const existed = native.existsSync!(resolved(path));
    const fd = native.openSync!(path, ...rest) as number;
    calls.push({ op: 'open', fd, path: fdPath(fd), created: !existed, directory: native.fstatSync!(fd).isDirectory() });
    return fd;
  };
  fsx.writeSync = (fd: number, data: Buffer, offset = 0, length = data.length - offset, position: number | null = null) => {
    calls.push({ op: 'write', fd, path: fdPath(fd), bytes: Buffer.from(data.subarray(offset, offset + length)), positioned: position !== null });
    return native.writeSync!(fd, data, offset, length, position);
  };
  fsx.fsyncSync = (fd: number) => { calls.push({ op: 'fsync', fd, path: fdPath(fd) }); return native.fsyncSync!(fd); };
  fsx.renameSync = (from: string, to: string) => { calls.push({ op: 'rename', from: resolved(from), to: resolved(to) }); return native.renameSync!(from, to); };
  fsx.linkSync = (from: string, to: string) => { calls.push({ op: 'link', from: resolved(from), to: resolved(to) }); return native.linkSync!(from, to); };
  fsx.unlinkSync = (path: string) => { calls.push({ op: 'unlink', path: resolved(path) }); return native.unlinkSync!(path); };
  fsx.ftruncateSync = (fd: number, ...rest: any[]) => { calls.push({ op: 'truncate', path: fdPath(fd) }); return native.ftruncateSync!(fd, ...rest); };
  syncBuiltinESMExports();
  try { fn(); } finally {
    for (const name of ['openSync', 'writeSync', 'fsyncSync', 'renameSync', 'linkSync', 'unlinkSync', 'ftruncateSync']) fsx[name] = native[name]!;
    syncBuiltinESMExports();
  }
  return calls;
}

function openS1(f: ReturnType<typeof fixture>): Session {
  const r = openSession({ ...f, sessionId: 'S1', runner: 'test', hardLimit: 10_000 });
  assert.equal(r.status, 'open');
  return r.session;
}

test('[REC-011] commit syscall order flushes snapshot, its directory and the prepared row before HEAD', () => {
  const f = fixture();
  const s = openS1(f);
  s.record([{ role: 'user', text: 'BASE' }]);
  const calls = traced(() => s.record([{ role: 'tool', text: 'ORDER_SENTINEL' }]));
  s.close();
  const state = s.stateDir, revisions = join(state, 'revisions');
  const temp = (file: string) => (p: string) => dirname(p) === dirname(file) && basename(p).startsWith(`${basename(file)}.ce-`) && p.endsWith('.tmp');
  const expected: Array<[string, (c: Call) => boolean]> = [
    ['fsync revisions/2.md temp', (c) => c.op === 'fsync' && temp(join(revisions, '2.md'))(c.path)],
    ['rename to revisions/2.md', (c) => c.op === 'rename' && c.to === join(revisions, '2.md')],
    ['fsync revisions/', (c) => c.op === 'fsync' && c.path === revisions],
    ['write revision-prepared row', (c) => c.op === 'write' && c.path === join(state, 'events.jsonl') && c.bytes.includes('"type":"revision-prepared"')],
    ['fsync events.jsonl', (c) => c.op === 'fsync' && c.path === join(state, 'events.jsonl')],
    ['fsync HEAD temp', (c) => c.op === 'fsync' && temp(join(state, 'HEAD'))(c.path)],
    ['rename to HEAD', (c) => c.op === 'rename' && c.to === join(state, 'HEAD')],
    ['fsync state directory', (c) => c.op === 'fsync' && c.path === state],
  ];
  let at = -1;
  for (const [name, match] of expected) {
    const next = calls.findIndex((c, i) => i > at && match(c));
    assert.ok(next > at, `${name} must follow the previous step; trace: ${calls.map((c) => `${c.op} ${('path' in c ? c.path : c.to).split('/').slice(-2).join('/')}`).join(', ')}`);
    at = next;
  }
});

interface Inode { volatile: Buffer; durable: Buffer }
type Image = Map<string, Buffer>;

/** The regular files of each directory, all treated as already durable. */
function filesIn(dirs: string[]): Map<string, Map<string, Inode>> {
  return new Map(dirs.map((dir) => [dir, new Map(fs.readdirSync(dir).filter((name) => fs.lstatSync(join(dir, name)).isFile()).map((name) => {
    const bytes = fs.readFileSync(join(dir, name));
    return [name, { volatile: bytes, durable: bytes }];
  }))]));
}

/**
 * Replays a trace on the modelled directories, starting from `base`. Data survives power loss only
 * after an fsync of its file, and a directory entry (create, rename, link, unlink) only after an
 * fsync of its directory. Returns the image a crash after each call would leave, in trace order.
 */
function crashImages(base: Map<string, Map<string, Inode>>, calls: Call[]): Image[] {
  const volatile = new Map([...base].map(([dir, entries]) => [dir, new Map(entries)]));
  const durable = new Map([...base].map(([dir, entries]) => [dir, new Map(entries)]));
  const entry = (path: string) => volatile.get(dirname(path))?.get(basename(path));
  const open = new Map<number, Inode | string>();
  const image = (): Image => new Map([...durable].flatMap(([dir, entries]) => [...entries].map(([name, inode]) => [join(dir, name), inode.durable] as [string, Buffer])));
  const images = [image()];
  for (const c of calls) {
    if (c.op === 'truncate' || (c.op === 'write' && c.positioned)) throw new Error(`unmodelled ${c.op} of ${c.path}`);
    if (c.op === 'open') {
      if (c.directory) { open.set(c.fd, c.path); continue; }
      if (!volatile.has(dirname(c.path))) { open.delete(c.fd); continue; }
      if (c.created) volatile.get(dirname(c.path))!.set(basename(c.path), { volatile: Buffer.alloc(0), durable: Buffer.alloc(0) });
      open.set(c.fd, entry(c.path)!);
    } else if (c.op === 'write') {
      const inode = open.get(c.fd);
      if (typeof inode === 'object') inode.volatile = Buffer.concat([inode.volatile, c.bytes]);
    } else if (c.op === 'fsync') {
      const target = open.get(c.fd);
      if (typeof target === 'object') target.durable = target.volatile;
      else if (typeof target === 'string' && volatile.has(target)) durable.set(target, new Map(volatile.get(target)));
      images.push(image());
    } else if (c.op === 'rename' || c.op === 'link') {
      const inode = entry(c.from);
      if (inode && volatile.has(dirname(c.to))) volatile.get(dirname(c.to))!.set(basename(c.to), inode);
      if (c.op === 'rename') volatile.get(dirname(c.from))?.delete(basename(c.from));
    } else if (c.op === 'unlink') volatile.get(dirname(c.path))?.delete(basename(c.path));
  }
  return images;
}

const imageKey = (image: Image) => JSON.stringify([...image].map(([p, b]) => [p, sha(b.toString('latin1'))]).sort());

test('[REC-011] every crash-consistent prefix of a commit trace recovers', () => {
  const f = fixture();
  const s = openS1(f);
  s.record([{ role: 'user', text: 'BASE_EVENT' }]);
  const dirs = [s.stateDir, join(s.stateDir, 'revisions'), dirname(s.workingContextPath)];
  const base = filesIn(dirs);
  const calls = traced(() => s.record([{ role: 'tool', text: 'DURABLE_SENTINEL' }]));
  const all = crashImages(base, calls);
  const final = imageKey(all.at(-1)!);
  const images = [...new Map(all.map((image) => [imageKey(image), image])).values()];
  assert.ok(images.length > 5, `${images.length} distinct crash images`);
  for (const [i, img] of images.entries()) {
    for (const dir of dirs) for (const name of fs.readdirSync(dir)) if (fs.lstatSync(join(dir, name)).isFile()) fs.unlinkSync(join(dir, name));
    for (const [path, bytes] of img) fs.writeFileSync(path, bytes);
    const reopened = openS1(f);
    const r = reopened.sync();
    const head = JSON.parse(fs.readFileSync(join(s.stateDir, 'HEAD'), 'utf8'));
    const snapshot = fs.readFileSync(join(s.stateDir, 'revisions', `${head.rev}.md`), 'utf8');
    assert.equal(sha(snapshot), head.sha, `image ${i}: HEAD names an existing matching snapshot`);
    assert.equal(r.revision, head.rev);
    const text = fs.readFileSync(s.workingContextPath, 'utf8');
    assert.equal(text, snapshot, `image ${i}: the Working Context is HEAD`);
    assert.equal(count(text, 'BASE_EVENT'), 1, `image ${i}: the acknowledged event once`);
    assert.ok(count(text, 'DURABLE_SENTINEL') <= 1, `image ${i}: the unacknowledged event at most once`);
    if (imageKey(img) === final) assert.equal(count(text, 'DURABLE_SENTINEL'), 1, 'the acknowledged record survives');
    reopened.close();
  }
});
