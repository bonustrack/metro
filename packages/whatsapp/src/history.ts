import { errMsg, log } from '@metro-labs/core/log';
import { TrainError } from '@metro-labs/core/train-error';
import type { WAMessage, WAMessageUpdate } from 'baileys';
import { HistoryEvents } from './history-events.js';
import { HistoryState } from './history-state.js';
import {
  HISTORY_LIMITS, HISTORY_SAVE_MS, HISTORY_SWEEP_MS, newestFirst,
  type History, type HistoryDelete, type HistoryOptions, type HistoryPage, type HistoryRow, type StoredRow,
} from './history-types.js';

export { historyFiles } from './history-state.js';
export type { History, HistoryOptions, HistoryPage, HistoryRow } from './history-types.js';

function shown(row: StoredRow): HistoryRow {
  return {
    key: { ...row.key }, messageId: row.key.id ?? '', chatJid: row.key.remoteJid ?? '',
    fromMe: row.key.fromMe === true, timestamp: new Date(row.at).toISOString(), text: row.text,
    ...(row.senderJid ? { senderJid: row.senderJid } : {}),
    ...(row.truncated ? { truncated: true } : {}),
    ...(row.attachments ? { attachments: row.attachments.map((a) => ({ ...a })) } : {}),
  };
}

function readBounds(options: HistoryOptions): { limit: number; since: number } {
  const limit = options.limit ?? 50;
  const since = options.since === undefined ? 0 : Date.parse(options.since);
  if (!Number.isInteger(limit) || limit < 1 || !Number.isFinite(since))
    throw new TrainError('bad_request', 'WhatsApp history needs a positive integer limit and a valid since timestamp');
  return { limit: Math.min(limit, HISTORY_LIMITS.pageSize), since };
}

const rowTime = (row: StoredRow | undefined): string | null => row === undefined ? null : new Date(row.at).toISOString();

function boundedPage(result: HistoryPage, rows: StoredRow[], limit: number): HistoryPage {
  let bytes = Buffer.byteLength(JSON.stringify(result));
  for (const row of rows.slice(0, limit)) {
    const message = shown(row);
    const added = Buffer.byteLength(JSON.stringify(message)) + 1;
    const cursor = Buffer.byteLength(JSON.stringify({ count: result.messages.length + 1, hasMore: true, nextBefore: message.messageId }));
    if (bytes + added + cursor > HISTORY_LIMITS.pageBytes) break;
    result.messages.push(message);
    bytes += added;
  }
  result.count = result.messages.length;
  result.hasMore = rows.length > result.count;
  if (result.hasMore) result.nextBefore = result.messages.at(-1)?.messageId;
  return result;
}

function page(state: HistoryState, jid: string, options: HistoryOptions): HistoryPage {
  const { limit, since } = readBounds(options);
  const rows = [...state.rows.values()].filter((row) => row.key.remoteJid === jid).sort(newestFirst);
  const before = options.before === undefined ? -1 : rows.findIndex((row) => row.key.id === options.before);
  if (options.before !== undefined && before < 0)
    throw new TrainError('whatsapp_history_cursor', 'The before message is not retained in this chat. Read without before to restart local pagination.');
  const matching = rows.slice(before + 1).filter((row) => row.at >= since);
  return boundedPage({
    messages: [], count: 0, hasMore: false,
    coverage: {
      partial: true, source: 'local',
      description: 'Only locally observed or synced messages and successful sends. Gaps remain; no older backfill or media downloads. View-once and unknown-expiry content is omitted. before is exclusive; since is inclusive. Pages stop at row or serialized-byte limits. hasMore describes retained local matches only.',
      oldest: rowTime(rows.at(-1)), newest: rowTime(rows[0]),
      retained: rows.length, retainedAfter: new Date(state.after(jid)).toISOString(), limits: HISTORY_LIMITS,
    },
  }, matching, limit);
}

class LocalHistory implements History {
  private readonly state: HistoryState;
  private readonly events: HistoryEvents;
  private readonly sweep: ReturnType<typeof setInterval>;
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;

  constructor(private readonly accountId: string) {
    this.state = new HistoryState(accountId);
    this.events = new HistoryEvents(this.state);
    this.state.prune(Date.now());
    this.sweep = setInterval(() => { this.saveSafely(); }, HISTORY_SWEEP_MS);
    this.sweep.unref();
    this.schedule();
  }

  private assertOpen(): void {
    if (this.closed) throw new TrainError('whatsapp_history_closed', 'WhatsApp local history is closed');
  }

  private saveSafely(): void {
    try {
      this.flush();
    } catch (err) {
      log.error({ accountId: this.accountId, err: errMsg(err) }, 'whatsapp: could not save local history');
    }
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.saveSafely(); }, HISTORY_SAVE_MS);
    this.timer.unref();
  }

  private changed(now: number): void {
    this.state.prune(now);
    this.schedule();
  }

  read(jid: string, options: HistoryOptions = {}): HistoryPage {
    this.assertOpen();
    this.changed(Date.now());
    return page(this.state, jid, options);
  }

  ingest(messages: readonly WAMessage[], selfJid?: string): void {
    this.assertOpen();
    const now = Date.now();
    for (const [index, message] of messages.entries()) {
      this.events.ingest(message, now, selfJid);
      if (index % 128 === 127) this.state.prune(now);
    }
    this.changed(now);
  }

  update(updates: readonly WAMessageUpdate[], selfJid?: string): void {
    this.assertOpen();
    const now = Date.now();
    for (const [index, update] of updates.entries()) {
      this.events.update(update, now, selfJid);
      if (index % 128 === 127) this.state.prune(now);
    }
    this.changed(now);
  }

  deleteMessages(event: HistoryDelete): void {
    this.assertOpen();
    const now = Date.now();
    if ('keys' in event) {
      for (const [index, key] of event.keys.entries()) {
        this.state.remove(key, now);
        if (index % 128 === 127) this.state.prune(now);
      }
    } else this.state.clear(event.jid, now);
    this.changed(now);
  }

  edit(jid: string, messageId: string, text: string): void {
    this.assertOpen();
    const now = Date.now();
    this.state.prune(now);
    this.events.edit(jid, messageId, text, now);
    this.changed(now);
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.state.flush();
  }

  close(): void {
    if (this.closed) return;
    clearInterval(this.sweep);
    this.closed = true;
    this.flush();
  }
}

export const createHistory = (accountId: string): History => new LocalHistory(accountId);
