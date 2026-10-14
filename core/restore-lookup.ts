import { dirname, join } from 'node:path';
import { statSync } from 'node:fs';
import { appendCommitted, atomicWrite, readBytes, readLogRows, removeDirectoryEntries, sha } from './store.ts';

type Identity = { dev: string; ino: string; size: number; mtime: string; ctime: string };
type Range = { start: number; end: number };
export type RestoreEntry = Range & { hash: string; confirmation?: Range };
type Shard = Map<string, RestoreEntry>;
type Commitment = { bytes: number; sha: string };
type Head = { version: 1; log: Identity; through: number; shards: Record<string, Commitment> };
type Decode = (row: Record<string, unknown>) => { id: string; hash: string } | undefined;
const NAMES = Array.from({ length: 64 }, (_, n) => n.toString(16).padStart(2, '0'));
const MAX = 4 * 1024 * 1024;
const EMPTY = sha('[]');
const bucket = (id: string) => (parseInt(sha(id).slice(0, 2), 16) >> 2).toString(16).padStart(2, '0');
const hex = (v: unknown, n: number): v is string => typeof v === 'string' && new RegExp(`^[a-f0-9]{${n}}$`).test(v);
const range = (v: unknown): v is Range => !!v && typeof v === 'object' && 'start' in v && 'end' in v && Number.isSafeInteger(v.start) && Number(v.start) >= 0 && Number.isSafeInteger(v.end) && Number(v.end) > Number(v.start);

function identity(log: string): Identity | undefined {
  try {
    const s = statSync(log, { bigint: true });
    if (!s.isFile() || s.nlink !== 1n || !Number.isSafeInteger(Number(s.size))) throw new Error('invalid restore lookup log identity');
    return { dev: String(s.dev), ino: String(s.ino), size: Number(s.size), mtime: String(s.mtimeNs), ctime: String(s.ctimeNs) };
  } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e; }
}

/** The complete evidence check remains independent of the derived lookup. */
export function validateRestoreSequences(log: string): void {
  let sequence = 1;
  for (const { entry } of readLogRows(log, 0, true)) if (entry.type === 'runner-events') {
    for (const event of entry.events as Array<{ seq: number }>) if (event.seq !== sequence++) throw new Error('runner evidence gap refuses restore confirmation without repair');
  }
}

function confirmationIds(row: Record<string, unknown>): string[] | undefined {
  if (row.type !== 'restore-notice-return-confirmed') return undefined;
  if (!Array.isArray(row.noticeIds) || !row.noticeIds.length || row.noticeIds.some(id => !hex(id, 32))) throw new Error('unknown durable restore notice confirmation');
  return row.noticeIds;
}

/** Disposable bounded shards. Only the Event Log supplies notice or confirmation evidence. */
export class RestoreLookup {
  private head: Head;
  private log: string;
  private decode: Decode;
  readonly changed = new Set<string>();
  rebuilt = false;
  private constructor(log: string, decode: Decode, head: Head) { this.log = log; this.decode = decode; this.head = head; }
  get end(): number { return this.head.through; }
  private path(name: string): string { return join(dirname(this.log), `restore-index-${name}.json`); }

  private static readHead(log: string): Head | undefined {
    const bytes = readBytes(join(dirname(log), 'restore-index.json'), 64 * 1024);
    if (!bytes) return undefined;
    try {
      const { checksum, ...h } = JSON.parse(bytes.toString('utf8'));
      if (checksum !== sha(JSON.stringify(h)) || h.version !== 1 || !h.log || typeof h.log.dev !== 'string'
          || typeof h.log.ino !== 'string' || typeof h.log.mtime !== 'string' || typeof h.log.ctime !== 'string'
          || !Number.isSafeInteger(h.log.size) || h.log.size < 0 || !Number.isSafeInteger(h.through) || h.through < 0 || h.through > h.log.size
          || !h.shards || Object.keys(h.shards).length !== 64) return undefined;
      for (const n of NAMES) {
        const s = h.shards[n];
        if (!s || !Number.isSafeInteger(s.bytes) || s.bytes < 2 || s.bytes > MAX || !hex(s.sha, 64) || (s.bytes === 2 && s.sha !== EMPTY)) return undefined;
      }
      return h as Head;
    } catch { return undefined; }
  }

  private shard(name: string): Shard | undefined {
    const commitment = this.head.shards[name]!;
    const bytes = commitment.bytes === 2 ? Buffer.from('[]') : readBytes(this.path(name), MAX);
    if (!bytes || bytes.length !== commitment.bytes || sha(bytes.toString('utf8')) !== commitment.sha) return undefined;
    try {
      const rows: unknown = JSON.parse(bytes.toString('utf8'));
      if (!Array.isArray(rows)) return undefined;
      const shard: Shard = new Map();
      for (const row of rows) {
        if (!Array.isArray(row) || row.length !== 2 || !hex(row[0], 32) || bucket(row[0]) !== name || !range(row[1]) || !('hash' in row[1]) || !hex(row[1].hash, 64)
            || row[1].end > this.head.through || ('confirmation' in row[1] && (!range(row[1].confirmation) || row[1].confirmation.end > this.head.through)) || shard.has(row[0])) return undefined;
        shard.set(row[0], row[1] as RestoreEntry);
      }
      return shard;
    } catch { return undefined; }
  }

  private writeShard(name: string, shard: Shard): void {
    const text = JSON.stringify([...shard]);
    if (Buffer.byteLength(text) > MAX) throw new Error('restore lookup shard exceeds 4 MiB; evidence retained, start a new session');
    atomicWrite(this.path(name), text, 'operation-index-tmp');
    this.head.shards[name] = { bytes: Buffer.byteLength(text), sha: sha(text) };
  }

  private publish(log: Identity): void {
    this.head.log = log;
    atomicWrite(join(dirname(this.log), 'restore-index.json'), JSON.stringify({ ...this.head, checksum: sha(JSON.stringify(this.head)) }), 'operation-index-tmp');
  }

  static open(log: string, decode: Decode): RestoreLookup {
    const h = this.readHead(log), current = identity(log);
    if (h && current && JSON.stringify(h.log) === JSON.stringify(current)) return new RestoreLookup(log, decode, h);
    return this.rebuild(log, decode);
  }

  /** One log pass into bounded buffers, then one shard at a time. No prefix scan per ID. */
  private static rebuild(log: string, decode: Decode): RestoreLookup {
    const before = identity(log) ?? { dev: '', ino: '', size: 0, mtime: '', ctime: '' };
    const head: Head = { version: 1, log: before, through: 0, shards: Object.fromEntries(NAMES.map(n => [n, { bytes: 2, sha: EMPTY }])) };
    const index = new RestoreLookup(log, decode, head);
    index.rebuilt = true;
    const buffers = new Map<string, string>(), lengths = new Map<string, number>();
    const spool = (n: string) => join(dirname(log), `restore-index-spool-${n}.jsonl`);
    const ownSpool = (n: string) => /^restore-index-spool-[0-3][0-9a-f]\.jsonl$/.test(n);
    const flush = (n: string) => {
      const text = buffers.get(n);
      if (!text) return;
      appendCommitted(spool(n), lengths.get(n) ?? 0, Buffer.from(text));
      lengths.set(n, (lengths.get(n) ?? 0) + Buffer.byteLength(text));
      buffers.delete(n);
    };
    const add = (id: string, row: Record<string, unknown>) => {
      const n = bucket(id);
      buffers.set(n, (buffers.get(n) ?? '') + JSON.stringify({ id, ...row }) + '\n');
      if (Buffer.byteLength(buffers.get(n)!) >= 64 * 1024) flush(n);
    };
    // These exact reserved files hold derived compact rows, never rejected payloads.
    removeDirectoryEntries(dirname(log), ownSpool);
    try {
      for (const row of readLogRows(log)) {
        const n = decode(row.entry);
        if (n) add(n.id, { hash: n.hash, start: row.start, end: row.end });
        for (const id of confirmationIds(row.entry) ?? []) add(id, { confirmation: { start: row.start, end: row.end } });
        head.through = row.end;
      }
      for (const n of NAMES) flush(n);
      for (const n of NAMES) {
        const shard: Shard = new Map();
        for (const { entry } of readLogRows(spool(n), 0, true)) {
          const id = String(entry.id), prior = shard.get(id);
          if (entry.hash !== undefined) {
            if (prior && prior.hash !== entry.hash) throw new Error('conflicting durable restore notice identity');
            if (!prior) shard.set(id, { hash: String(entry.hash), start: Number(entry.start), end: Number(entry.end) });
          } else {
            if (!prior) throw new Error('unknown durable restore notice confirmation');
            prior.confirmation = entry.confirmation as Range;
          }
          if (shard.size * 160 > MAX) throw new Error('restore lookup shard exceeds its bounded capacity; evidence retained, start a new session');
        }
        if (shard.size) index.writeShard(n, shard);
      }
      const after = identity(log) ?? before;
      if (JSON.stringify(after) !== JSON.stringify(before)) throw new Error('restore evidence changed during lookup rebuild; close and reopen');
      index.publish(after);
      return index;
    } finally { removeDirectoryEntries(dirname(log), ownSpool); }
  }

  /** Verify a selected hit against its original retained rows. */
  private matches(id: string, e: RestoreEntry): boolean {
    for (const row of readLogRows(this.log, e.start)) {
      const n = this.decode(row.entry);
      if (row.end !== e.end || n?.id !== id || n.hash !== e.hash) return false;
      if (!e.confirmation) return true;
      for (const c of readLogRows(this.log, e.confirmation.start)) return c.end === e.confirmation.end && (confirmationIds(c.entry) ?? []).includes(id);
      return false;
    }
    return false;
  }

  get(id: string, retry = true): RestoreEntry | undefined {
    const shard = this.shard(bucket(id)), e = shard?.get(id);
    if (shard && (!e || this.matches(id, e))) return e;
    if (!retry) throw new Error('restore lookup disagrees with retained evidence');
    const rebuilt = RestoreLookup.rebuild(this.log, this.decode);
    this.head = rebuilt.head;
    return this.get(id, false);
  }

  *pending(retry = true): Generator<string> {
    // Validate every shard before yielding any state, so fallback cannot duplicate results.
    for (const n of NAMES) if (!this.shard(n)) {
      if (!retry) throw new Error('restore lookup rebuild disagrees with evidence');
      this.head = RestoreLookup.rebuild(this.log, this.decode).head;
      yield* this.pending(false);
      return;
    }
    for (const n of NAMES) for (const [id, e] of this.shard(n)!) if (!e.confirmation) {
      if (!this.matches(id, e)) throw new Error('pending restore lookup disagrees with retained evidence');
      yield id;
    }
  }

  /** Extend a known live cursor. A damaged cache takes one complete rebuild. */
  static refresh(log: string, from: number, decode: Decode): RestoreLookup {
    const h = this.readHead(log), before = identity(log);
    if (!h || !before || h.through !== from || h.log.dev !== before.dev || h.log.ino !== before.ino || before.size < from) return this.rebuild(log, decode);
    const index = new RestoreLookup(log, decode, h);
    let loaded: { name: string; entries: Shard } | undefined;
    const flush = () => { if (loaded) index.writeShard(loaded.name, loaded.entries); };
    const load = (id: string): Shard | undefined => {
      const name = bucket(id);
      if (loaded?.name !== name) {
        flush();
        const entries = index.shard(name);
        if (!entries) return undefined;
        loaded = { name, entries };
      }
      return loaded.entries;
    };
    for (const row of readLogRows(log, from, true)) {
      h.through = row.end;
      const n = decode(row.entry);
      if (n) {
        index.changed.add(n.id);
        const s = load(n.id);
        if (!s) return this.rebuild(log, decode);
        const prior = s.get(n.id);
        if (prior && prior.hash !== n.hash) throw new Error('conflicting durable restore notice identity');
        if (!prior) s.set(n.id, { hash: n.hash, start: row.start, end: row.end });
      }
      for (const id of confirmationIds(row.entry) ?? []) {
        index.changed.add(id);
        const s = load(id);
        if (!s) return this.rebuild(log, decode);
        const prior = s.get(id);
        if (!prior) throw new Error('unknown durable restore notice confirmation');
        prior.confirmation = { start: row.start, end: row.end };
      }
    }
    flush();
    const after = identity(log);
    if (!after || JSON.stringify(before) !== JSON.stringify(after)) throw new Error('restore evidence changed during lookup refresh; close and reopen');
    index.publish(after);
    return index;
  }
}
