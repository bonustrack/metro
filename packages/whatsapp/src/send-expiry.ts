import type { ChatUpdate, WASocket } from 'baileys';
import { errMsg, log } from '@metro-labs/core/log';
import { isGroupJid, isPrivateJid } from './parse.js';

const MAX_CHATS = 2000;
type Content = Parameters<WASocket['sendMessage']>[1];
interface Setting { duration: number; at: number }

function duration(value: number | undefined): number | undefined {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function setting(chat: ChatUpdate): Setting | undefined {
  if (!Object.hasOwn(chat, 'ephemeralExpiration')) return undefined;
  const seconds = duration(chat.ephemeralExpiration === null ? 0 : chat.ephemeralExpiration);
  const timestamp = chat.ephemeralSettingTimestamp;
  const at = typeof timestamp === 'number' ? timestamp : timestamp?.toNumber();
  if (seconds === undefined || at === undefined || !Number.isSafeInteger(at) || at <= 0) return undefined;
  return { duration: seconds, at };
}

export class SendExpiry {
  private readonly chats = new Map<string, Setting>();

  constructor(private readonly accountId: string) {}

  private note(chat: ChatUpdate): void {
    if (!chat.id || !isPrivateJid(chat.id)) return;
    const next = setting(chat);
    if (!next) return;
    const known = this.chats.get(chat.id);
    if (known && known.at > next.at) return;
    this.chats.delete(chat.id);
    this.chats.set(chat.id, next);
    if (this.chats.size > MAX_CHATS) {
      const oldest = this.chats.keys().next().value;
      if (oldest !== undefined) this.chats.delete(oldest);
    }
  }

  bind(sock: WASocket, current: () => boolean): void {
    this.chats.clear();
    const note = (chats: readonly ChatUpdate[]): void => {
      if (current()) for (const chat of chats) this.note(chat);
    };
    sock.ev.on('chats.upsert', note);
    sock.ev.on('chats.update', note);
    sock.ev.on('messaging-history.set', ({ chats }) => { note(chats); });
    sock.ev.on('chats.delete', (jids) => {
      if (current()) for (const jid of jids) this.chats.delete(jid);
    });
  }

  async forSend(sock: WASocket, jid: string, content: Content): Promise<number | undefined> {
    if ('edit' in content || 'delete' in content || 'react' in content) return undefined;
    if (!isGroupJid(jid)) return this.chats.get(jid)?.duration;
    try {
      const group = await sock.groupMetadata(jid);
      return duration(group.ephemeralDuration ?? 0);
    } catch (err) {
      log.warn({ accountId: this.accountId, err: errMsg(err) }, 'whatsapp: send expiry unknown; local history may omit the message');
      return undefined;
    }
  }
}
