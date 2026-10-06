import { readFileSync } from 'node:fs';
import { isRecord } from '@metro-labs/core/is-record';
import { errMsg, log } from '@metro-labs/core/log';
import { writeSecure } from '@metro-labs/core/secure-fs';
import {
  DIRECTORY_LIMIT,
  type ChannelEntry,
  type ChannelSnapshot,
} from '@metro-labs/core/stations/channel-directory';
import { lineOf } from './accounts.js';
import type { TgChat, TgMsg, TgMyChatMember, TgUpdate } from './types.js';

type Metadata = Omit<ChannelEntry, 'line'>;

const kinds = new Set(['direct', 'group', 'channel', 'thread']);
const chatId = (id: number): boolean => Number.isSafeInteger(id) && id !== 0;
const cleanName = (name: string | undefined): string | undefined =>
  name?.trim() ? Array.from(name.trim()).slice(0, 256).join('') : undefined;

function kindOf(chat: TgChat): Metadata['kind'] | undefined {
  if (chat.type === 'private') return 'direct';
  if (chat.type === 'group' || chat.type === 'supergroup') return 'group';
  if (chat.type === 'channel') return 'channel';
  return undefined;
}

function metadataOf(raw: unknown): Metadata | undefined {
  if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.kind !== 'string') return undefined;
  if (!/^-?[1-9]\d*(\/[1-9]\d*)?$/.test(raw.id) || !kinds.has(raw.kind)) return undefined;
  const parts = raw.id.split('/').map(Number);
  if (!parts.every(chatId) || (raw.kind === 'thread') !== (parts.length === 2)) return undefined;
  const name = typeof raw.name === 'string' ? cleanName(raw.name) : undefined;
  return { id: raw.id, kind: raw.kind as Metadata['kind'], ...(name ? { name } : {}) };
}

function savedMetadata(account: string, file: string): unknown[] {
  const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (!isRecord(raw) || raw.version !== 1 || raw.account !== account || !Array.isArray(raw.channels))
    throw new Error('invalid observed chat metadata');
  return raw.channels.slice(-DIRECTORY_LIMIT);
}

function topicIdOf(message: TgMsg): number | undefined {
  if (!message.is_topic_message || message.chat.type !== 'supergroup' || !chatId(message.chat.id)) return undefined;
  const id = message.message_thread_id;
  return id !== undefined && Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

function loaded(account: string, file: string | undefined): Map<string, Metadata> {
  const entries = new Map<string, Metadata>();
  if (file === undefined) return entries;
  try {
    for (const value of savedMetadata(account, file)) {
      const entry = metadataOf(value);
      if (entry) entries.set(entry.id, entry);
    }
  } catch (err) {
    if (!isRecord(err) || err.code !== 'ENOENT')
      log.warn({ account, err: errMsg(err) }, 'telegram-bot: could not load observed chats');
  }
  return entries;
}

export class ObservedChats {
  private readonly entries: Map<string, Metadata>;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly account: string, private readonly file?: string) {
    this.entries = loaded(account, file);
  }

  snapshot(): ChannelSnapshot {
    const channels = [...this.entries.values()].map((entry) => {
      const [chat, topic] = entry.id.split('/');
      return { ...entry, line: lineOf(this.account, chat ?? '', topic === undefined ? undefined : Number(topic)) };
    });
    return {
      channels,
      capability: {
        supported: true,
        complete: false,
        source: 'local',
        reason: `Telegram Bot API has no all-chats API. Only chat and topic metadata observed in updates on this box is available, up to ${DIRECTORY_LIMIT} entries; unobserved chats and missed updates are not included.`,
      },
    };
  }

  observe(update: TgUpdate): void {
    for (const message of [update.message, update.channel_post])
      if (message) this.message(message);
    for (const event of [update.message_reaction, update.message_reaction_count])
      if (event) this.chat(event.chat);
    if (update.my_chat_member) this.membership(update.my_chat_member);
  }

  flush(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.file === undefined) return;
    writeSecure(this.file, JSON.stringify({ version: 1, account: this.account, channels: [...this.entries.values()] }));
  }

  private changed(): void {
    if (this.file === undefined || this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      try {
        this.flush();
      } catch (err) {
        log.warn({ account: this.account, err: errMsg(err) }, 'telegram-bot: could not save observed chats');
      }
    }, 2000);
    this.timer.unref();
  }

  private note(entry: Metadata): void {
    const previous = this.entries.get(entry.id);
    const name = entry.name ?? previous?.name;
    this.entries.delete(entry.id);
    this.entries.set(entry.id, { id: entry.id, kind: entry.kind, ...(name ? { name } : {}) });
    if (this.entries.size > DIRECTORY_LIMIT) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    if (!previous || previous.name !== name || previous.kind !== entry.kind) this.changed();
  }

  private remove(id: number): void {
    for (const key of this.entries.keys()) {
      if (key === String(id) || key.startsWith(`${id}/`)) {
        this.entries.delete(key);
        this.changed();
      }
    }
  }

  private chat(chat: TgChat): void {
    const kind = kindOf(chat);
    if (!chatId(chat.id) || kind === undefined) return;
    const name = cleanName(kind === 'direct'
      ? [chat.first_name, chat.last_name].map((part) => part?.trim()).filter(Boolean).join(' ') || (chat.username ? `@${chat.username}` : undefined)
      : chat.title);
    this.note({ id: String(chat.id), kind, ...(name ? { name } : {}) });
  }

  private message(message: TgMsg): void {
    if (message.migrate_to_chat_id !== undefined && chatId(message.migrate_to_chat_id)) {
      this.remove(message.chat.id);
      this.chat({ ...message.chat, id: message.migrate_to_chat_id, type: 'supergroup' });
      return;
    }
    if (message.migrate_from_chat_id !== undefined && chatId(message.migrate_from_chat_id))
      this.remove(message.migrate_from_chat_id);
    this.chat(message.chat);
    this.topic(message);
  }

  private topic(message: TgMsg): void {
    const topic = topicIdOf(message);
    if (topic === undefined) return;
    const name = cleanName(message.forum_topic_edited?.name ?? message.forum_topic_created?.name);
    this.note({ id: `${message.chat.id}/${topic}`, kind: 'thread', ...(name ? { name } : {}) });
  }

  private membership(update: TgMyChatMember): void {
    const { status, is_member: isMember } = update.new_chat_member;
    if (status === 'left' || status === 'kicked' || (status === 'restricted' && isMember === false))
      this.remove(update.chat.id);
    else if (status === 'creator' || status === 'administrator' || status === 'member'
      || (status === 'restricted' && isMember === true))
      this.chat(update.chat);
  }
}
