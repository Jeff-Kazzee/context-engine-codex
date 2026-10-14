import { randomBytes } from 'node:crypto';
import { appendLog, readLogRows, sha } from './store.ts';
import { RestoreLookup, validateRestoreSequences } from './restore-lookup.ts';
import type { RestoreReason } from './session.ts';

/** A durable request to restore, not proof that its following rename completed. */
export interface RestoreNotice {
  id: string;
  revision: number;
  sha256: string;
  reason: RestoreReason;
  chars: number;
  rejectedSha256: string;
  text: string;
}

const reasons = ['missing', 'empty', 'not-utf8', 'over-hard-limit', 'not-a-file', 'unmaterialized-append'];
const hex = (value: unknown, size: number): value is string => typeof value === 'string' && new RegExp(`^[a-f0-9]{${size}}$`).test(value);

export function decodeRestoreNotice(value: unknown): RestoreNotice {
  if (!value || typeof value !== 'object') throw new Error('invalid durable restore notice');
  const n = value as Record<string, unknown>;
  if (!hex(n.id, 32) || !hex(n.sha256, 64) || !hex(n.rejectedSha256, 64)
      || !Number.isSafeInteger(n.revision) || Number(n.revision) < 1
      || !Number.isSafeInteger(n.chars) || Number(n.chars) < 0 || !reasons.includes(String(n.reason))) {
    throw new Error('invalid durable restore notice');
  }
  const notice = { id: n.id, revision: Number(n.revision), sha256: n.sha256, reason: n.reason as RestoreReason, chars: Number(n.chars), rejectedSha256: n.rejectedSha256 };
  return { ...notice, text: `Context Engine: restoration of Working Context revision ${notice.revision} was requested (${notice.reason}). The durable request does not prove the later file rename completed. The rejected edit or its rejection is retained in the Event Log. Read the current Working Context file before editing it again.` };
}

function loggedNotice(row: Record<string, unknown>): { id: string; hash: string } | undefined {
  if (row.type !== 'restored' || row.notice === undefined) return undefined;
  const n = decodeRestoreNotice(row.notice);
  const rejected = { ...(row.rejected !== undefined ? { rejected: row.rejected } : {}), ...(row.rejectedBase64 !== undefined ? { rejectedBase64: row.rejectedBase64 } : {}), ...(row.oversized !== undefined ? { oversized: row.oversized } : {}) };
  if (row.rev !== n.revision || row.reason !== n.reason || sha(JSON.stringify(rejected)) !== n.rejectedSha256) throw new Error('restore notice identity conflicts with its retained edit');
  return { id: n.id, hash: sha(JSON.stringify(n)) };
}

function noticeAt(log: string, index: RestoreLookup, id: string): { notice: RestoreNotice; start: number } {
  const hit = index.get(id);
  if (!hit) throw new Error('unknown restore notice ID');
  for (const row of readLogRows(log, hit.start)) return { notice: decodeRestoreNotice(row.entry.notice), start: hit.start };
  throw new Error('missing retained restore notice');
}

/** Only pending payloads remain in memory. Confirmed identity evidence stays in bounded shards. */
export function restoreNoticeState(log: string, strict = false): { notices: Map<string, RestoreNotice>; confirmed: Set<string>; end: number } {
  if (strict) validateRestoreSequences(log);
  const index = RestoreLookup.open(log, loggedNotice);
  const pending = [...index.pending()].map(id => noticeAt(log, index, id)).sort((a, b) => a.start - b.start);
  return { notices: new Map(pending.map(p => [p.notice.id, p.notice])), confirmed: new Set(), end: index.end };
}

export function pendingRestoreNotices(log: string): Map<string, RestoreNotice> {
  return restoreNoticeState(log).notices;
}

export function keepRestoreIntent(log: string, pending: Map<string, RestoreNotice>, head: { rev: number; sha: string }, reason: RestoreReason, chars: number, rejected: Record<string, unknown>): { notice: RestoreNotice; appended: boolean } {
  const rejectedSha256 = sha(JSON.stringify(rejected));
  const notice = decodeRestoreNotice({ id: randomBytes(16).toString('hex'), revision: head.rev, sha256: head.sha, reason, chars, rejectedSha256 });
  appendLog(log, { type: 'restored', rev: head.rev, reason, ...rejected, notice });
  pending.set(notice.id, notice);
  return { notice, appended: true };
}

/** Validate the whole batch before one append. A repeated confirmed ID is harmless. */
export function confirmRestoreNoticeIds(log: string, ids: readonly string[]): void {
  if (!Array.isArray(ids) || ids.length > 1024 || ids.some(id => !hex(id, 32))) throw new Error('invalid restore notice confirmation IDs');
  validateRestoreSequences(log);
  const index = RestoreLookup.open(log, loggedNotice), owed: string[] = [];
  for (const id of new Set(ids)) {
    const hit = index.get(id);
    if (!hit) throw new Error('unknown restore notice ID, no notice was confirmed');
    if (!hit.confirmation) owed.push(id);
  }
  if (owed.length) appendLog(log, { type: 'restore-notice-return-confirmed', noticeIds: owed }, { requireCompleteTail: true });
}

export function restoreNoticeSummary(represented: number, total: number): string {
  return `Context Engine: ${total} restore request(s) remain pending. This notice represents ${represented} request(s). A restore request preceded file publication and does not prove the rename completed. Rejected edits or their rejections remain in the Event Log. Read the current Working Context file before editing it again. Additional requests remain queued until their represented IDs are confirmed.`;
}

/** Process only complete appended rows. The caller binds the log inode and cursor. */
export function refreshRestoreNotices(log: string, from: number, pending: Map<string, RestoreNotice>): number {
  const index = RestoreLookup.refresh(log, from, loggedNotice);
  if (index.rebuilt) {
    const current = restoreNoticeState(log);
    pending.clear();
    for (const [id, n] of current.notices) pending.set(id, n);
  } else for (const id of index.changed) {
    if (index.get(id)?.confirmation) pending.delete(id);
    else pending.set(id, noticeAt(log, index, id).notice);
  }
  return index.end;
}
