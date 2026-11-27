import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseId } from '@metro-labs/core/ids';
import { isRecord } from '@metro-labs/core/is-record';
import { errMsg, log } from '@metro-labs/core/log';
import { writeSecure } from '@metro-labs/core/secure-fs';

const FILE = 'chat-sessions.json';
const KEPT_MAX = 2_000;
const SESSION_RE = /^[A-Za-z0-9-]{8,64}$/;

interface Kept {
  sessions: Map<string, string>;
  hidden: Set<string>;
  readable: boolean;
}

const sessionOf = (value: unknown): string | null => (typeof value === 'string' && SESSION_RE.test(value) ? value : null);

function parsed(raw: unknown): Kept | null {
  if (!isRecord(raw) || raw.version !== 1 || !isRecord(raw.sessions) || (raw.hidden !== undefined && !Array.isArray(raw.hidden))) return null;
  const sessions = new Map<string, string>();
  for (const [chat, value] of Object.entries(raw.sessions)) {
    const session = sessionOf(value);
    if (parseId(chat) !== null && session !== null) sessions.set(chat, session);
  }
  const listed = Array.isArray(raw.hidden) ? raw.hidden : [];
  const hidden = new Set([...sessions.values(), ...listed.map(sessionOf).filter((id): id is string => id !== null)].map((id) => id.toLowerCase()));
  return { sessions, hidden, readable: true };
}

const empty = (readable: boolean): Kept => ({ sessions: new Map(), hidden: new Set(), readable });

export class ChatSessions {
  private kept: Kept | null = null;

  constructor(private readonly dir: string) {}

  private get path(): string {
    return join(this.dir, FILE);
  }

  private load(): Kept {
    if (this.kept !== null) return this.kept;
    this.kept = this.read();
    return this.kept;
  }

  private read(): Kept {
    if (!existsSync(this.path)) return empty(true);
    try {
      const kept = parsed(JSON.parse(readFileSync(this.path, 'utf8')));
      if (kept !== null) return kept;
    } catch (err) {
      log.error({ err: errMsg(err) }, 'chat: the chat sessions file cannot be read');
    }
    log.error({ path: this.path }, 'chat: the chat sessions file is unreadable, so every transcript stays off the Sessions page and the file is left as it is until it is fixed or removed');
    return empty(false);
  }

  hides(session: string): boolean {
    const kept = this.load();
    return !kept.readable || kept.hidden.has(session.toLowerCase());
  }

  of(chat: string): string | null {
    return this.load().sessions.get(chat) ?? null;
  }

  keep(chat: string, session: string): void {
    if (sessionOf(session) === null) return;
    const kept = this.load();
    kept.hidden.add(session.toLowerCase());
    if (kept.sessions.get(chat) === session) return;
    kept.sessions.delete(chat);
    kept.sessions.set(chat, session);
    while (kept.sessions.size > KEPT_MAX) kept.sessions.delete(kept.sessions.keys().next().value ?? '');
    if (kept.readable) this.save(kept);
  }

  private save(kept: Kept): void {
    try {
      writeSecure(this.path, `${JSON.stringify({ version: 1, sessions: Object.fromEntries(kept.sessions), hidden: [...kept.hidden] })}\n`);
    } catch (err) {
      log.warn({ err: errMsg(err) }, 'chat: the chat session could not be kept, the next message starts a new one');
    }
  }
}
