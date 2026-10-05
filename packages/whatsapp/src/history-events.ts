import { proto, WAMessageStubType, type WAMessage, type WAMessageKey, type WAMessageUpdate } from 'baileys';
import { clipped, historyContent, historyKey, numberOf, projectMessage } from './history-message.js';
import { HISTORY_LIMITS, slotOf, type StoredRow } from './history-types.js';
import type { HistoryState } from './history-state.js';

const earlierExpiry = (a?: number, b?: number): number | undefined => a === undefined ? b : b === undefined ? a : Math.min(a, b);

function removed(event: WAMessageUpdate): boolean {
  return event.key.isViewOnce === true || event.update.message === null || event.update.messageStubType === WAMessageStubType.REVOKE;
}

function editedRow(old: StoredRow, row: StoredRow, revision: number): StoredRow {
  const expiresAt = earlierExpiry(old.expiresAt, row.expiresAt);
  return { ...old, ...row, truncated: row.truncated ?? false, editedAt: revision, ...(expiresAt === undefined ? {} : { expiresAt }) };
}

export class HistoryEvents {
  constructor(private readonly state: HistoryState) {}

  private edited(key: WAMessageKey, message: proto.IMessage, revision: number, now: number, selfJid?: string): void {
    const slot = slotOf(key);
    const old = this.state.rows.get(slot);
    if (!old) {
      this.state.remove(key, now);
      return;
    }
    const row = projectMessage({ key: old.key, message, messageTimestamp: old.at / 1000 }, now, selfJid);
    if (row === 'omit') this.state.remove(old.key, now);
    if (!row || row === 'omit' || revision > now || revision <= (old.editedAt ?? old.at)) return;
    this.state.rows.set(slot, editedRow(old, row, revision));
  }

  private protocol(message: WAMessage, now: number, selfJid?: string): boolean {
    const protocol = historyContent(message.message).message?.protocolMessage;
    if (!protocol) return false;
    if (!protocol.key?.id) return true;
    const key = { ...message.key, id: protocol.key.id };
    if (protocol.type === proto.Message.ProtocolMessage.Type.REVOKE) this.state.remove(key, now);
    if (protocol.type === proto.Message.ProtocolMessage.Type.MESSAGE_EDIT && protocol.editedMessage) {
      const revision = numberOf(protocol.timestampMs) ?? (numberOf(message.messageTimestamp) ?? 0) * 1000;
      this.edited(key, protocol.editedMessage, revision, now, selfJid);
    }
    return true;
  }

  ingest(message: WAMessage, now: number, selfJid?: string): void {
    if (!historyKey(message.key)) return;
    if (message.messageStubType === WAMessageStubType.REVOKE) {
      this.state.remove(message.key, now);
      return;
    }
    if (this.protocol(message, now, selfJid)) return;
    const row = projectMessage(message, now, selfJid);
    if (row === 'omit') this.state.remove(message.key, now);
    if (!row || row === 'omit' || this.state.blocked(row.key, row.at)) return;
    const slot = slotOf(row.key);
    const old = this.state.rows.get(slot);
    if (!old) {
      this.state.rows.set(slot, row);
      return;
    }
    this.duplicate(old, row);
  }

  private duplicate(old: StoredRow, row: StoredRow): void {
    const expiresAt = earlierExpiry(old.expiresAt, row.expiresAt);
    if (expiresAt !== undefined) old.expiresAt = expiresAt;
    if (old.key.fromMe === true && old.senderJid === undefined && row.key.fromMe === true && row.senderJid) old.senderJid = row.senderJid;
  }

  update(event: WAMessageUpdate, now: number, selfJid?: string): void {
    const { key, update } = event;
    if (!historyKey(key)) return;
    if (removed(event)) {
      this.state.remove(key, now);
      return;
    }
    if (update.ephemeralDuration || update.ephemeralStartTimestamp) {
      this.state.remove(key, now);
      return;
    }
    if (!update.message) return;
    const full = { ...update, key };
    if (this.protocol(full, now, selfJid)) return;
    const revision = (numberOf(update.messageTimestamp) ?? 0) * 1000;
    if (revision) this.edited(key, update.message, revision, now, selfJid);
    else this.state.remove(key, now);
  }

  edit(jid: string, messageId: string, source: string, now: number): void {
    const old = this.state.rows.get(slotOf({ remoteJid: jid, id: messageId }));
    if (!old) {
      this.state.remove({ remoteJid: jid, id: messageId }, now);
      return;
    }
    const text = clipped(source, HISTORY_LIMITS.textBytes);
    this.state.rows.set(slotOf(old.key), { ...old, text, truncated: text !== source, editedAt: now });
  }
}
