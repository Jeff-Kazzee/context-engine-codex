import { randomBytes } from 'node:crypto';
import { appendLog, readLogRows, sha } from './store.ts';
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

/** Old ID-less restored rows, including revision zero rejections, remain readable. */
export function restoreNoticeState(log: string, strict = false): { notices: Map<string, RestoreNotice>; confirmed: Set<string>; end: number } {
  const notices = new Map<string, RestoreNotice>(), confirmed = new Set<string>();
  let expectedSequence = 1, end = 0;
  for (const { entry: row, end: rowEnd } of readLogRows(log, 0, strict)) {
    end = rowEnd;
    if (strict && row.type === 'runner-events') for (const event of row.events as Array<{ seq: number }>) {
      if (event.seq !== expectedSequence++) throw new Error('runner evidence gap refuses restore confirmation without repair');
    }
    if (row.type === 'restored' && row.notice !== undefined) {
      const notice = decodeRestoreNotice(row.notice);
      if (row.rev !== notice.revision || row.reason !== notice.reason || notice.rejectedSha256 !== sha(JSON.stringify({ ...(row.rejected !== undefined ? { rejected: row.rejected } : {}), ...(row.rejectedBase64 !== undefined ? { rejectedBase64: row.rejectedBase64 } : {}), ...(row.oversized !== undefined ? { oversized: row.oversized } : {}) }))) throw new Error('restore notice identity conflicts with its retained edit');
      const prior = notices.get(notice.id);
      if (prior && JSON.stringify(prior) !== JSON.stringify(notice)) throw new Error('conflicting durable restore notice identity');
      notices.set(notice.id, notice);
    } else if (row.type === 'restore-notice-return-confirmed') {
      if (!Array.isArray(row.noticeIds) || !row.noticeIds.length || row.noticeIds.some(id => typeof id !== 'string' || !notices.has(id))) throw new Error('unknown durable restore notice confirmation');
      for (const id of row.noticeIds as string[]) confirmed.add(id);
    }
  }
  return { notices, confirmed, end };
}

export function pendingRestoreNotices(log: string): Map<string, RestoreNotice> {
  const { notices, confirmed } = restoreNoticeState(log);
  return new Map([...notices].filter(([id]) => !confirmed.has(id)));
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
  const { notices, confirmed } = restoreNoticeState(log, true);
  if (ids.some(id => !notices.has(id))) throw new Error('unknown restore notice ID, no notice was confirmed');
  const owed = [...new Set(ids)].filter(id => !confirmed.has(id));
  if (owed.length) appendLog(log, { type: 'restore-notice-return-confirmed', noticeIds: owed }, { requireCompleteTail: true });
}

export function restoreNoticeSummary(represented: number, total: number): string {
  return `Context Engine: ${total} restore request(s) remain pending. This notice represents ${represented} request(s). A restore request preceded file publication and does not prove the rename completed. Rejected edits or their rejections remain in the Event Log. Read the current Working Context file before editing it again. Additional requests remain queued until their represented IDs are confirmed.`;
}

/** Process only complete appended rows. The caller binds the log inode and cursor. */
export function refreshRestoreNotices(log: string, from: number, pending: Map<string, RestoreNotice>, known: Map<string, RestoreNotice>): number {
  let end = from;
  for (const { entry: row, end: rowEnd } of readLogRows(log, from, true)) {
    if (row.type === 'restored' && row.notice !== undefined) {
      const notice = decodeRestoreNotice(row.notice);
      const rejected = { ...(row.rejected !== undefined ? { rejected: row.rejected } : {}), ...(row.rejectedBase64 !== undefined ? { rejectedBase64: row.rejectedBase64 } : {}), ...(row.oversized !== undefined ? { oversized: row.oversized } : {}) };
      if (row.rev !== notice.revision || row.reason !== notice.reason || sha(JSON.stringify(rejected)) !== notice.rejectedSha256) throw new Error('restore notice identity conflicts with its retained edit');
      const prior = known.get(notice.id);
      if (prior && JSON.stringify(prior) !== JSON.stringify(notice)) throw new Error('conflicting durable restore notice identity');
      if (!prior) pending.set(notice.id, notice);
      known.set(notice.id, notice);
    } else if (row.type === 'restore-notice-return-confirmed') {
      if (!Array.isArray(row.noticeIds) || !row.noticeIds.length || row.noticeIds.some(id => typeof id !== 'string' || !known.has(id))) throw new Error('unknown durable restore notice confirmation');
      for (const id of row.noticeIds as string[]) pending.delete(id);
    }
    end = rowEnd;
  }
  return end;
}
