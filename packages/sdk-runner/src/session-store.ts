import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isRecord } from '@metro-labs/core/is-record';
import { writeAtomic } from '@metro-labs/core/secure-fs';
import type { Unanswered, Uuid } from './inbox.js';
import { recoverInputs } from './recovery.js';

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const projectFolder = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, '-');

interface Stored {
  sessionId: string | null;
  unanswered: Unanswered[];
  interrupted: Unanswered[];
  context?: number;
}

function inputId(raw: unknown): Uuid | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !SESSION_ID.test(raw)) throw new Error(UNREADABLE);
  return raw as Uuid;
}

function inputState(raw: unknown): Unanswered['state'] {
  if (raw === undefined || raw === 'queued' || raw === 'started') return raw;
  throw new Error(UNREADABLE);
}

function entry(raw: unknown): Unanswered | null {
  if (!isRecord(raw) || typeof raw.text !== 'string' || typeof raw.at !== 'number') return null;
  const uuid = inputId(raw.uuid);
  const state = inputState(raw.state);
  return { text: raw.text, at: raw.at, ...(uuid === undefined ? {} : { uuid }), ...(state === undefined ? {} : { state }) };
}

const UNREADABLE = 'The saved Agent SDK state cannot be read. Restore it before starting.';

function contextOf(raw: unknown): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) throw new Error(UNREADABLE);
  return raw;
}

function stored(raw: unknown): Stored {
  if (!isRecord(raw)) throw new Error(UNREADABLE);
  const id = raw.sessionId ?? null;
  if (id !== null && (typeof id !== 'string' || !SESSION_ID.test(id))) throw new Error(UNREADABLE);
  const context = contextOf(raw.context);
  return { sessionId: id, unanswered: entries(raw.unanswered), interrupted: entries(raw.interrupted), ...(context === undefined ? {} : { context }) };
}

function entries(raw: unknown): Unanswered[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error(UNREADABLE);
  const list = raw.map(entry);
  if (!list.every((e): e is Unanswered => e !== null)) throw new Error(UNREADABLE);
  return list;
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

  recover(): Stored {
    const stored = this.read();
    const transcript = stored.sessionId === null ? null : join(this.claudeDir, 'projects', projectFolder(this.cwd), `${stored.sessionId}.jsonl`);
    const recovered = recoverInputs(stored.unanswered, transcript);
    const next = { ...stored, unanswered: recovered.unanswered, interrupted: [...stored.interrupted, ...recovered.interrupted] };
    if (stored.unanswered.length > 0) this.write(next);
    return next;
  }

  save(id: string): void {
    const stored = this.read();
    if (!SESSION_ID.test(id) || stored.sessionId === id) return;
    this.write({ ...stored, sessionId: id });
  }

  saveUnanswered(unanswered: Unanswered[]): void {
    this.write({ ...this.read(), unanswered });
  }

  saveContext(context: number): void {
    const stored = this.read();
    if (stored.context !== context) this.write({ ...stored, context });
  }

  private read(): Stored {
    try {
      return stored(JSON.parse(readFileSync(this.path, 'utf8')));
    } catch (err) {
      if (isRecord(err) && err.code === 'ENOENT') return { sessionId: null, unanswered: [], interrupted: [] };
      throw new Error(UNREADABLE);
    }
  }

  private write(stored: Stored): void {
    writeAtomic(this.path, `${JSON.stringify({ ...stored, savedAt: new Date().toISOString() }, null, 2)}\n`, 0o600);
  }
}
