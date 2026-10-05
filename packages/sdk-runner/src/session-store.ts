import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isRecord } from '@metro-labs/core/is-record';
import { writeAtomic } from '@metro-labs/core/secure-fs';
import type { Unanswered } from './inbox.js';

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const projectFolder = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, '-');

interface Stored {
  sessionId: string | null;
  unanswered: Unanswered[];
}

const entry = (raw: unknown): Unanswered | null =>
  isRecord(raw) && typeof raw.text === 'string' && typeof raw.at === 'number' ? { text: raw.text, at: raw.at } : null;

const UNREADABLE = 'The saved Agent SDK state cannot be read. Restore it before starting.';

function stored(raw: unknown): Stored {
  if (!isRecord(raw)) throw new Error(UNREADABLE);
  const id = raw.sessionId ?? null;
  if (id !== null && (typeof id !== 'string' || !SESSION_ID.test(id))) throw new Error(UNREADABLE);
  const list = raw.unanswered === undefined ? [] : raw.unanswered;
  if (!Array.isArray(list)) throw new Error(UNREADABLE);
  const unanswered = list.map(entry);
  if (!unanswered.every((e): e is Unanswered => e !== null)) throw new Error(UNREADABLE);
  return { sessionId: id, unanswered };
}

export class SessionStore {
  constructor(
    private readonly path: string,
    private readonly claudeDir: string,
    private readonly cwd: string,
  ) {}

  resumable(): string | null {
    const id = this.read().sessionId;
    if (id === null) return null;
    return existsSync(join(this.claudeDir, 'projects', projectFolder(this.cwd), `${id}.jsonl`)) ? id : null;
  }

  unanswered(): Unanswered[] {
    return this.read().unanswered;
  }

  save(id: string): void {
    const stored = this.read();
    if (!SESSION_ID.test(id) || stored.sessionId === id) return;
    this.write({ ...stored, sessionId: id });
  }

  saveUnanswered(unanswered: Unanswered[]): void {
    this.write({ ...this.read(), unanswered });
  }

  private read(): Stored {
    try {
      return stored(JSON.parse(readFileSync(this.path, 'utf8')));
    } catch (err) {
      if (isRecord(err) && err.code === 'ENOENT') return { sessionId: null, unanswered: [] };
      throw new Error(UNREADABLE);
    }
  }

  private write(stored: Stored): void {
    writeAtomic(this.path, `${JSON.stringify({ ...stored, savedAt: new Date().toISOString() }, null, 2)}\n`, 0o600);
  }
}
