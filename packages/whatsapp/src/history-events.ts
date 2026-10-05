import { proto, WAMessageStubType, type WAMessage, type WAMessageKey, type WAMessageUpdate } from 'baileys';
import { clipped, historyContent, historyKey, numberOf, projectMessage } from './history-message.js';
import { isGroupJid } from './parse.js';
import { HISTORY_LIMITS, type StoredRow } from './history-types.js';
import type { HistoryState } from './history-state.js';

const earlierExpiry = (a?: number, b?: number): number | undefined => a === undefined ? b : b === undefined ? a : Math.min(a, b);
const timestamp = (message: WAMessage): number | undefined => {
  const seconds = numberOf(message.messageTimestamp);
  return seconds === undefined ? undefined : seconds * 1000;
};

function removed(event: WAMessageUpdate): boolean {
  return event.key.isViewOnce === true || event.update.message === null || event.update.messageStubType === WAMessageStubType.REVOKE;
}

function acceptedSent(row: StoredRow, sent?: { expiration?: number }): boolean {
  return !sent || (row.key.fromMe === true && (row.expiresAt !== undefined || sent.expiration === 0));
}

function editedRow(old: StoredRow, row: StoredRow, revision: number): StoredRow {
  const expiresAt = earlierExpiry(old.expiresAt, row.expiresAt);
  return { ...old, ...row, truncated: row.truncated ?? false, editedAt: revision, ...(expiresAt === undefined ? {} : { expiresAt }) };
}

export class HistoryEvents {
  constructor(private readonly state: HistoryState) {}

  private author(old: WAMessageKey, editor: WAMessageKey): boolean {
    if ((old.fromMe === true) !== (editor.fromMe === true)) return false;
    if (!isGroupJid(old.remoteJid ?? '')) return true;
    if (old.participant && editor.participant) return this.state.same(old.participant, editor.participant);
    return old.fromMe === true;
  }

  private edited(key: WAMessageKey, message: proto.IMessage, revision: number, now: number, selfJid?: string): void {
    const old = this.state.get(key);
    if (!old) {
      this.state.remove(key, now);
      return;
    }
    if (!this.author(old.key, key)) return;
    const row = projectMessage({ key: old.key, message, messageTimestamp: old.at / 1000 }, now, selfJid);
    if (row === 'omit') this.state.remove(old.key, now, old.at);
    if (!row || row === 'omit' || revision > now || revision <= (old.editedAt ?? old.at)) return;
    this.state.put(editedRow(old, row, revision));
  }

  private protocol(message: WAMessage, now: number, selfJid?: string): boolean {
    const protocol = historyContent(message.message).message?.protocolMessage;
    if (!protocol) return false;
    if (!protocol.key?.id) return true;
    if (protocol.key.remoteJid && !this.state.same(protocol.key.remoteJid, message.key.remoteJid ?? '')) return true;
    const key = historyKey({ ...message.key, id: protocol.key.id });
    if (key) this.applyProtocol(key, protocol, message, now, selfJid);
    return true;
  }

  private applyProtocol(key: WAMessageKey, protocol: proto.Message.IProtocolMessage, message: WAMessage, now: number, selfJid?: string): void {
    if (protocol.type === proto.Message.ProtocolMessage.Type.REVOKE) this.state.remove(key, now);
    if (protocol.type === proto.Message.ProtocolMessage.Type.MESSAGE_EDIT && protocol.editedMessage) {
      const revision = numberOf(protocol.timestampMs) ?? timestamp(message) ?? 0;
      this.edited(key, protocol.editedMessage, revision, now, selfJid);
    }
  }

  ingest(message: WAMessage, now: number, selfJid?: string, sent?: { expiration?: number }): void {
    if (!historyKey(message.key)) return;
    const at = timestamp(message);
    if (at !== undefined && this.state.outside(message.key, at, now)) return;
    this.state.observe(message.key, now);
    if (message.messageStubType === WAMessageStubType.REVOKE) {
      this.state.remove(message.key, now, at);
      return;
    }
    if (!this.protocol(message, now, selfJid)) this.content(message, now, selfJid, sent);
  }

  private content(message: WAMessage, now: number, selfJid?: string, sent?: { expiration?: number }): void {
    const row = projectMessage(message, now, selfJid, sent?.expiration);
    if (row === 'omit') this.state.remove(message.key, now, timestamp(message));
    if (!row || row === 'omit' || this.state.blocked(row.key, row.at) || !acceptedSent(row, sent)) return;
    const old = this.state.get(row.key);
    if (old) this.duplicate(old, row);
    else this.state.put(row);
  }

  private duplicate(old: StoredRow, row: StoredRow): void {
    const expiresAt = earlierExpiry(old.expiresAt, row.expiresAt);
    if (expiresAt !== undefined) old.expiresAt = expiresAt;
    if (old.key.fromMe === true && old.senderJid === undefined && row.key.fromMe === true && row.senderJid) old.senderJid = row.senderJid;
  }

  update(event: WAMessageUpdate, now: number, selfJid?: string): void {
    const { key, update } = event;
    if (!historyKey(key)) return;
    const originalAt = this.state.get(key)?.at ?? timestamp({ ...update, key });
    if (removed(event) || update.ephemeralDuration || update.ephemeralStartTimestamp) {
      this.state.remove(key, now, originalAt);
      return;
    }
    this.state.observe(key, now);
    if (!update.message) return;
    const full = { ...update, key };
    if (this.protocol(full, now, selfJid)) return;
    const revision = timestamp(full);
    if (revision) this.edited(key, update.message, revision, now, selfJid);
    else this.refresh(full, now, selfJid);
  }

  private refresh(message: WAMessage, now: number, selfJid?: string): void {
    const old = this.state.get(message.key);
    const row = projectMessage({ ...message, messageTimestamp: old ? old.at / 1000 : undefined }, now, selfJid);
    if (row === 'omit') this.state.remove(message.key, now, old?.at);
    else if (row && old) this.duplicate(old, row);
  }

  edit(jid: string, messageId: string, source: string, now: number): void {
    const old = this.state.get({ remoteJid: jid, id: messageId });
    if (!old) {
      this.state.remove({ remoteJid: jid, id: messageId }, now);
      return;
    }
    const text = clipped(source, HISTORY_LIMITS.textBytes);
    this.state.put({ ...old, text, truncated: text !== source, editedAt: now });
  }
}
