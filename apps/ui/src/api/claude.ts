import { daemonBase } from '../auth/daemon.js';
import { call } from './client.js';
import { isRecord } from './accounts.js';

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

export async function fetchClaudeProjects(): Promise<ClaudeProject[]> {
  const body = await call({ base: base(), path: '/projects', method: 'GET' });
  if (!isRecord(body)) throw unexpected();
  return list(body.projects, toProject);
}

export async function fetchClaudeSessions(project: string): Promise<ClaudeSession[]> {
  const body = await call({ base: base(), path: `/sessions?project=${encodeURIComponent(project)}`, method: 'GET' });
  if (!isRecord(body)) throw unexpected();
  return list(body.sessions, toSession);
}

export async function fetchTranscript(
  project: string,
  id: string,
  offset: number,
  limit: number,
): Promise<TranscriptPage> {
  const body = await call({
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

export async function deleteClaudeSession(project: string, id: string): Promise<void> {
  await call({
    base: base(),
    path: `/sessions/${id}?project=${encodeURIComponent(project)}`,
    method: 'DELETE',
  });
}

export async function fetchMemory(project: string): Promise<MemoryListing> {
  const body = await call({ base: base(), path: `/memory?project=${encodeURIComponent(project)}`, method: 'GET' });
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

export async function fetchMemoryFile(project: string, name: string): Promise<string> {
  const body = await call({
    base: base(),
    path: `/memory/${encodeURIComponent(name)}?project=${encodeURIComponent(project)}`,
    method: 'GET',
  });
  if (!isRecord(body) || typeof body.content !== 'string') throw unexpected();
  return body.content;
}

const SCOPES = ['user', 'project', 'local'] as const;

export type SettingsScope = (typeof SCOPES)[number];

const isScope = (v: unknown): v is SettingsScope => SCOPES.some((scope) => scope === v);

export interface ClaudeSettingsFile {
  id: string;
  scope: SettingsScope;
  label: string;
  path: string;
  exists: boolean;
  editable: boolean;
  text: string;
  modifiedAt: string | null;
}

export function toSettingsFile(v: unknown): ClaudeSettingsFile | null {
  if (!isRecord(v) || typeof v.id !== 'string' || !isScope(v.scope) || typeof v.path !== 'string') return null;
  return {
    id: v.id,
    scope: v.scope,
    label: text(v.label) ?? v.path,
    path: v.path,
    exists: v.exists === true,
    editable: v.editable === true,
    text: typeof v.text === 'string' ? v.text : '',
    modifiedAt: text(v.modifiedAt),
  };
}

export async function fetchClaudeSettings(): Promise<ClaudeSettingsFile[]> {
  const body = await call({ base: base(), path: '/settings', method: 'GET' });
  if (!isRecord(body)) throw unexpected();
  return list(body.files, toSettingsFile);
}

export async function saveClaudeSettings(id: string, content: string, seenAt: string | null): Promise<ClaudeSettingsFile> {
  const body = await call({
    base: base(),
    path: `/settings/${encodeURIComponent(id)}`,
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: content, seenAt }),
  });
  const file = toSettingsFile(body);
  if (file === null) throw unexpected();
  return file;
}

export type LoginState = 'pending' | 'done' | 'failed';

export interface ClaudeLogin {
  id: string;
  state: LoginState;
  url: string | null;
  output: string;
  error: string | null;
}

export interface ClaudeAccount {
  available: boolean;
  signedIn: boolean;
  account: string | null;
}

const isState = (value: unknown): value is LoginState => value === 'pending' || value === 'done' || value === 'failed';

function toLogin(body: unknown): ClaudeLogin {
  if (!isRecord(body) || typeof body.id !== 'string' || !isState(body.state)) throw unexpected();
  return {
    id: body.id,
    state: body.state,
    url: text(body.url),
    output: typeof body.output === 'string' ? body.output : '',
    error: text(body.error),
  };
}

export async function fetchClaudeAccount(): Promise<ClaudeAccount> {
  const body = await call({ base: base(), path: '/login', method: 'GET' });
  if (!isRecord(body)) throw unexpected();
  return { available: body.available === true, signedIn: body.signedIn === true, account: text(body.account) };
}

export async function startClaudeLogin(): Promise<ClaudeLogin> {
  return toLogin(await call({ base: base(), path: '/login', method: 'POST' }));
}

export async function pollClaudeLogin(id: string): Promise<ClaudeLogin> {
  return toLogin(await call({ base: base(), path: `/login/${encodeURIComponent(id)}`, method: 'GET' }));
}

export async function answerClaudeLogin(id: string, code: string): Promise<ClaudeLogin> {
  return toLogin(
    await call({
      base: base(),
      path: `/login/${encodeURIComponent(id)}`,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: code }),
    }),
  );
}

export async function cancelClaudeLogin(id: string): Promise<void> {
  await call({ base: base(), path: `/login/${encodeURIComponent(id)}`, method: 'DELETE' });
}

async function claudeCall(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<unknown> {
  return call({
    base: base(),
    path,
    method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
}

export interface ClaudeSkill {
  id: string;
  name: string;
  title: string;
  description: string;
  scope: 'user' | 'project';
  where: string;
  path: string;
  editable: boolean;
  updatedAt: string | null;
}

export interface SkillPlace {
  id: string;
  scope: 'user' | 'project';
  where: string;
}

export interface SkillListing {
  skills: ClaudeSkill[];
  places: SkillPlace[];
}

const skillText = (value: unknown): string => (typeof value === 'string' ? value : '');

function toSkill(raw: unknown): ClaudeSkill | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.name !== 'string') return null;
  const title = skillText(raw.title);
  return {
    id: raw.id,
    name: raw.name,
    title: title === '' ? raw.name : title,
    description: skillText(raw.description),
    scope: raw.scope === 'project' ? 'project' : 'user',
    where: skillText(raw.where),
    path: skillText(raw.path),
    editable: raw.editable !== false,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
  };
}

const skillOrThrow = (raw: unknown): ClaudeSkill => {
  const skill = toSkill(raw);
  if (skill === null) throw new Error('Metro returned an unexpected response.');
  return skill;
};

const skillPath = (id: string): string => `/skills/${encodeURIComponent(id)}`;

export async function fetchClaudeSkills(): Promise<SkillListing> {
  const body = await claudeCall('GET', '/skills');
  if (!isRecord(body)) return { skills: [], places: [] };
  const skills = Array.isArray(body.skills) ? body.skills.flatMap((raw) => toSkill(raw) ?? []) : [];
  const places = Array.isArray(body.places)
    ? body.places.flatMap((raw) =>
        isRecord(raw) && typeof raw.id === 'string'
          ? [{ id: raw.id, scope: raw.scope === 'project' ? ('project' as const) : ('user' as const), where: typeof raw.where === 'string' ? raw.where : '' }]
          : [],
      )
    : [];
  return { skills, places };
}

export async function fetchClaudeSkill(id: string): Promise<ClaudeSkill & { text: string }> {
  const body = await claudeCall('GET', skillPath(id));
  const skill = skillOrThrow(body);
  return { ...skill, text: isRecord(body) && typeof body.text === 'string' ? body.text : '' };
}

export async function saveClaudeSkill(id: string, text: string, seenAt: string | null): Promise<ClaudeSkill> {
  return skillOrThrow(await claudeCall('PUT', skillPath(id), { text, seenAt }));
}

export async function createClaudeSkill(name: string, scope: string): Promise<ClaudeSkill> {
  return skillOrThrow(await claudeCall('POST', '/skills', { name, scope }));
}

export async function deleteClaudeSkill(id: string): Promise<void> {
  await claudeCall('DELETE', skillPath(id));
}
