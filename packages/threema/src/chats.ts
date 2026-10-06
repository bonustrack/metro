import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { log } from '@metro-labs/core/log';
import { accountFiles } from '@metro-labs/core/stations/account-files';
import { DIRECTORY_LIMIT } from '@metro-labs/core/stations/channel-directory';
import { isThreemaId, normalizeThreemaId } from './ids.js';

interface DirectChat {
  id: string;
  name?: string;
}

export const chatFiles = accountFiles('THREEMA_GROUPS_DIR', 'threema-chats-');

const nameOf = (name: unknown): string | undefined =>
  typeof name === 'string' ? Array.from(name.trim()).slice(0, 256).join('') || undefined : undefined;

function directChat(entry: unknown): DirectChat | undefined {
  if (!entry || typeof entry !== 'object' || !('id' in entry) || typeof entry.id !== 'string') return undefined;
  const id = normalizeThreemaId(entry.id);
  if (!isThreemaId(id)) return undefined;
  const name = nameOf('name' in entry ? entry.name : undefined);
  return { id, ...(name ? { name } : {}) };
}

function readChats(path: string): Map<string, DirectChat> {
  try {
    if (statSync(path).size > DIRECTORY_LIMIT * 2048) throw new Error('Threema chat metadata is too large');
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    const chats = new Map<string, DirectChat>();
    if (!Array.isArray(raw)) throw new Error('Threema chat metadata must be an array');
    for (const entry of raw.slice(-DIRECTORY_LIMIT)) {
      const chat = directChat(entry);
      if (chat) chats.set(chat.id, chat);
    }
    return chats;
  } catch (err) {
    if (!(err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT'))
      log.warn({ err, path }, 'threema: could not load chat metadata');
    return new Map();
  }
}

export class DirectStore {
  private readonly path: string;
  private readonly chats: Map<string, DirectChat>;

  constructor(accountId: string) {
    this.path = chatFiles.path(accountId);
    this.chats = readChats(this.path);
  }

  list(): DirectChat[] {
    return [...this.chats.values()].map((chat) => ({ ...chat }));
  }

  note(rawId: string, rawName?: string): void {
    const id = normalizeThreemaId(rawId);
    if (!isThreemaId(id)) return;
    const previous = this.chats.get(id);
    const name = nameOf(rawName) ?? previous?.name;
    if (previous && name === previous.name) return;
    this.chats.delete(id);
    this.chats.set(id, { id, ...(name ? { name } : {}) });
    while (this.chats.size > DIRECTORY_LIMIT) {
      const oldest = this.chats.keys().next();
      if (oldest.done) break;
      this.chats.delete(oldest.value);
    }
    this.save();
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.${randomUUID()}.tmp`;
      try {
        writeFileSync(tmp, JSON.stringify(this.list()), { mode: 0o600, flag: 'wx' });
        renameSync(tmp, this.path);
      } finally {
        rmSync(tmp, { force: true });
      }
    } catch (err) {
      log.warn({ err, path: this.path }, 'threema: could not save chat metadata');
    }
  }
}
