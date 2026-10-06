import { readFileSync, statSync } from 'node:fs';
import { isRecord } from '@metro-labs/core/is-record';
import { errMsg, log } from '@metro-labs/core/log';
import { writeSecure } from '@metro-labs/core/secure-fs';
import { accountFiles } from '@metro-labs/core/stations/account-files';
import { DIRECTORY_LIMIT, type ChannelEntry } from '@metro-labs/core/stations/channel-directory';
import { lineOf } from './accounts.js';

export const channelFiles = accountFiles('WHATSAPP_TOKEN_DIR', 'whatsapp-channels-');
const FILE_BYTES = 16 * 1024 * 1024;
const NAME_LIMIT = 256;

interface ChatMetadata {
  id?: string | null;
  name?: string | null;
}

interface StoredChat {
  id: string;
  name?: string;
  deleted?: true;
}

function directId(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 128 || !/^\d+(?::\d+)?@(s\.whatsapp\.net|lid)$/.test(value)) return undefined;
  return value.replace(/:\d+@/, '@');
}

export function channelName(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim().slice(0, NAME_LIMIT) || undefined : undefined;
}

function storedChat(row: unknown): StoredChat | undefined {
  if (!isRecord(row)) return undefined;
  const id = directId(row.id);
  if (!id) return undefined;
  return row.deleted === true ? { id, deleted: true } : { id, name: channelName(row.name) };
}

export class KnownChats {
  private readonly chats = new Map<string, StoredChat>();
  private readonly file: string;

  constructor(private readonly accountId: string) {
    this.file = channelFiles.path(accountId);
    this.load();
  }

  private load(): void {
    try {
      if (statSync(this.file).size > FILE_BYTES) throw new Error('channel metadata file is too large');
      const raw: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      if (!Array.isArray(raw)) throw new Error('invalid channel metadata');
      for (const row of raw.slice(-DIRECTORY_LIMIT)) {
        const chat = storedChat(row);
        if (chat) this.put(chat);
      }
    } catch (err) {
      if (isRecord(err) && err.code === 'ENOENT') return;
      log.warn({ accountId: this.accountId, err: errMsg(err) }, 'whatsapp: could not load channel metadata');
    }
  }

  private put(row: StoredChat): void {
    this.chats.delete(row.id);
    this.chats.set(row.id, row);
    if (this.chats.size > DIRECTORY_LIMIT) {
      const oldest = this.chats.keys().next().value;
      if (oldest !== undefined) this.chats.delete(oldest);
    }
  }

  private save(): void {
    try {
      writeSecure(this.file, JSON.stringify([...this.chats.values()]));
    } catch (err) {
      log.warn({ accountId: this.accountId, err: errMsg(err) }, 'whatsapp: could not save channel metadata');
    }
  }

  private noteChat(chat: ChatMetadata, fresh: boolean): boolean {
    const id = directId(chat.id);
    if (!id) return false;
    const prior = this.chats.get(id);
    if (prior?.deleted && !fresh) return false;
    const name = channelName(chat.name) ?? prior?.name;
    if (prior && !prior.deleted && prior.name === name) return false;
    this.put({ id, name });
    return true;
  }

  note(chats: readonly ChatMetadata[], fresh = false): void {
    let changed = false;
    for (const chat of chats) {
      if (this.noteChat(chat, fresh)) changed = true;
    }
    if (changed) this.save();
  }

  remove(ids: readonly string[]): void {
    let changed = false;
    for (const value of ids) {
      const id = directId(value);
      if (!id || this.chats.get(id)?.deleted) continue;
      this.put({ id, deleted: true });
      changed = true;
    }
    if (changed) this.save();
  }

  list(): ChannelEntry[] {
    return [...this.chats.values()].filter((chat) => !chat.deleted).map(({ id, name }) => ({
      id, line: lineOf(this.accountId, id), kind: 'direct', ...(name ? { name } : {}),
    }));
  }
}
