import { daemonBase } from '../auth/daemon.js';
import { call } from './client.js';
import { isRecord } from './read.js';

export interface FileEntry {
  name: string;
  kind: 'folder' | 'file' | 'other';
  bytes: number;
  modifiedAt: string;
}

export type AgentPath =
  | { kind: 'folder'; path: string; root: string; entries: FileEntry[]; more: boolean }
  | { kind: 'file'; path: string; root: string; bytes: number; modifiedAt: string; text: string | null; truncated: boolean };

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function entryOf(raw: unknown): FileEntry | null {
  if (!isRecord(raw) || typeof raw.name !== 'string') return null;
  const kind = raw.kind === 'folder' || raw.kind === 'file' ? raw.kind : 'other';
  return { name: raw.name, kind, bytes: num(raw.bytes), modifiedAt: str(raw.modifiedAt) };
}

function toAgentPath(body: unknown): AgentPath {
  if (!isRecord(body)) throw new Error('Metro returned an unexpected response.');
  const base = { path: str(body.path), root: str(body.root) };
  if (body.kind === 'folder' && Array.isArray(body.entries))
    return { ...base, kind: 'folder', entries: body.entries.map(entryOf).filter((e): e is FileEntry => e !== null), more: body.more === true };
  if (body.kind === 'file')
    return { ...base, kind: 'file', bytes: num(body.bytes), modifiedAt: str(body.modifiedAt), text: typeof body.text === 'string' ? body.text : null, truncated: body.truncated === true };
  throw new Error('Metro returned an unexpected response.');
}

export async function fetchAgentPath(path: string): Promise<AgentPath> {
  return toAgentPath(await call({ method: 'GET', base: `${daemonBase()}/api/files`, path: `?path=${encodeURIComponent(path)}` }));
}

export const joinPath = (parent: string, name: string): string => (parent === '' ? name : `${parent}/${name}`);

export const pathSegments = (path: string): string[] => path.split('/').filter((part) => part !== '');
