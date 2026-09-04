import { call } from './client';
import { isRecord } from './accounts';
import { daemonBase } from '../auth/session';

export interface ClaudeProject {
  id: string;
  cwd: string | null;
  sessions: number;
  lastActiveAt: string | null;
  hasMemory: boolean;
}

export interface ClaudeSession {
  id: string;
  title: string;
  startedAt: string | null;
  lastAt: string | null;
  bytes: number;
  gitBranch: string | null;
}

export type Block =
  | { kind: 'text'; text: string }
  | { kind: 'tool_use'; name: string; input: string }
  | { kind: 'tool_result'; text: string; isError: boolean }
  | { kind: 'thinking' }
  | { kind: 'image' };

export interface TranscriptEntry {
  uuid: string;
  at: string | null;
  role: 'user' | 'assistant';
  blocks: Block[];
}

export interface TranscriptPage {
  entries: TranscriptEntry[];
  total: number;
  next: number | null;
}

export interface MemoryFile {
  name: string;
  bytes: number;
  modifiedAt: string;
}

export interface MemoryListing {
  files: MemoryFile[];
  index: string | null;
}

const base = (): string => `${daemonBase()}/api/claude`;
const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
const unexpected = (): Error => new Error('Metro returned an unexpected response.');

function toProject(v: unknown): ClaudeProject | null {
  if (!isRecord(v) || typeof v.id !== 'string') return null;
  return {
    id: v.id,
    cwd: text(v.cwd),
    sessions: num(v.sessions),
    lastActiveAt: text(v.lastActiveAt),
    hasMemory: v.hasMemory === true,
  };
}

function toSession(v: unknown): ClaudeSession | null {
  if (!isRecord(v) || typeof v.id !== 'string') return null;
  return {
    id: v.id,
    title: text(v.title) ?? 'Untitled session',
    startedAt: text(v.startedAt),
    lastAt: text(v.lastAt),
    bytes: num(v.bytes),
    gitBranch: text(v.gitBranch),
  };
}

const BLOCKS: Record<string, (v: Record<string, unknown>) => Block> = {
  text: (v) => ({ kind: 'text', text: text(v.text) ?? '' }),
  tool_use: (v) => ({ kind: 'tool_use', name: text(v.name) ?? 'tool', input: text(v.input) ?? '' }),
  tool_result: (v) => ({ kind: 'tool_result', text: text(v.text) ?? '', isError: v.isError === true }),
  thinking: () => ({ kind: 'thinking' }),
  image: () => ({ kind: 'image' }),
};

function toBlock(v: unknown): Block | null {
  if (!isRecord(v) || typeof v.kind !== 'string') return null;
  const make = BLOCKS[v.kind];
  return make === undefined ? null : make(v);
}

function toEntry(v: unknown): TranscriptEntry | null {
  if (!isRecord(v) || (v.role !== 'user' && v.role !== 'assistant')) return null;
  const blocks = Array.isArray(v.blocks) ? v.blocks.map(toBlock).filter((b): b is Block => b !== null) : [];
  return { uuid: text(v.uuid) ?? '', at: text(v.at), role: v.role, blocks };
}

const list = <T>(v: unknown, make: (x: unknown) => T | null): T[] =>
  Array.isArray(v) ? v.map(make).filter((x): x is T => x !== null) : [];

export async function fetchClaudeProjects(token: string): Promise<ClaudeProject[]> {
  const body = await call(token, { base: base(), path: '/projects', method: 'GET' });
  if (!isRecord(body)) throw unexpected();
  return list(body.projects, toProject);
}

export async function fetchClaudeSessions(token: string, project: string): Promise<ClaudeSession[]> {
  const body = await call(token, { base: base(), path: `/sessions?project=${encodeURIComponent(project)}`, method: 'GET' });
  if (!isRecord(body)) throw unexpected();
  return list(body.sessions, toSession);
}

export async function fetchTranscript(
  token: string,
  project: string,
  id: string,
  offset: number,
  limit: number,
): Promise<TranscriptPage> {
  const body = await call(token, {
    base: base(),
    path: `/sessions/${id}?project=${encodeURIComponent(project)}&offset=${String(offset)}&limit=${String(limit)}`,
    method: 'GET',
  });
  if (!isRecord(body)) throw unexpected();
  return {
    entries: list(body.entries, toEntry),
    total: num(body.total),
    next: typeof body.next === 'number' ? body.next : null,
  };
}

export async function deleteClaudeSession(token: string, project: string, id: string): Promise<void> {
  await call(token, {
    base: base(),
    path: `/sessions/${id}?project=${encodeURIComponent(project)}`,
    method: 'DELETE',
  });
}

export async function fetchMemory(token: string, project: string): Promise<MemoryListing> {
  const body = await call(token, { base: base(), path: `/memory?project=${encodeURIComponent(project)}`, method: 'GET' });
  if (!isRecord(body)) throw unexpected();
  const files = Array.isArray(body.files)
    ? body.files.flatMap((f: unknown) =>
        isRecord(f) && typeof f.name === 'string'
          ? [{ name: f.name, bytes: num(f.bytes), modifiedAt: text(f.modifiedAt) ?? '' }]
          : [],
      )
    : [];
  return { files, index: text(body.index) };
}

export async function fetchMemoryFile(token: string, project: string, name: string): Promise<string> {
  const body = await call(token, {
    base: base(),
    path: `/memory/${encodeURIComponent(name)}?project=${encodeURIComponent(project)}`,
    method: 'GET',
  });
  if (!isRecord(body) || typeof body.content !== 'string') throw unexpected();
  return body.content;
}
