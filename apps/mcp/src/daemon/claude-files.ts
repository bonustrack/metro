import {
  closeSync,
  createReadStream,
  existsSync,
  openSync,
  readdirSync,
  readSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { ApiError } from './api-error.js';

const PROJECT_RE = /^[A-Za-z0-9._-]{1,200}$/;
const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/;
const MEMORY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.md$/;
const EDGE_BYTES = 64 * 1024;
const TEXT_CAP = 20_000;
const RESULT_CAP = 8_000;
const INPUT_CAP = 4_000;
const FILE_CAP = 1_000_000;
const NOISE = ['<task-notification>', '<system-reminder>', '<local-command', '<command-name>'];

export function claudeDir(): string {
  const explicit = process.env.METRO_CLAUDE_DIR?.trim();
  if (explicit !== undefined && explicit !== '') return explicit;
  const cfg = process.env.CLAUDE_CONFIG_DIR?.trim();
  if (cfg !== undefined && cfg !== '') return cfg;
  return join(homedir(), '.claude');
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

function safeName(value: string, re: RegExp, what: string): string {
  if (!re.test(value) || value === '.' || value === '..')
    throw new ApiError(`that is not a ${what}`, 400);
  return value;
}

function projectDir(project: string, dir: string): string {
  const path = join(dir, 'projects', safeName(project, PROJECT_RE, 'Claude project id'));
  if (!existsSync(path)) throw new ApiError('no such Claude project', 404);
  return path;
}

function parseLines(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRecord(parsed)) out.push(parsed);
    } catch {
      continue;
    }
  }
  return out;
}

function readEdge(path: string, fromEnd: boolean): Record<string, unknown>[] {
  const size = statSync(path).size;
  const length = Math.min(EDGE_BYTES, size);
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, fromEnd ? size - length : 0);
    const text = buffer.toString('utf8');
    const cut = fromEnd && length < size ? text.indexOf('\n') + 1 : 0;
    return parseLines(text.slice(cut));
  } finally {
    closeSync(fd);
  }
}

export interface ClaudeProject {
  id: string;
  cwd: string | null;
  sessions: number;
  lastActiveAt: string | null;
  hasMemory: boolean;
}

function sessionFiles(path: string): { name: string; mtime: number; size: number }[] {
  return readdirSync(path)
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => {
      const s = statSync(join(path, name));
      return { name, mtime: s.mtimeMs, size: s.size };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

function cwdOf(path: string): string | null {
  for (const line of readEdge(path, false)) {
    const cwd = str(line.cwd);
    if (cwd !== null) return cwd;
  }
  return null;
}

export function listClaudeProjects(dir = claudeDir()): ClaudeProject[] {
  const root = join(dir, 'projects');
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && PROJECT_RE.test(entry.name))
    .map((entry) => {
      const path = join(root, entry.name);
      const files = sessionFiles(path);
      const newest = files[0];
      return {
        id: entry.name,
        cwd: newest === undefined ? null : cwdOf(join(path, newest.name)),
        sessions: files.length,
        lastActiveAt: newest === undefined ? null : new Date(newest.mtime).toISOString(),
        hasMemory: existsSync(join(path, 'memory')),
      };
    })
    .sort((a, b) => (b.lastActiveAt ?? '').localeCompare(a.lastActiveAt ?? ''));
}

export interface ClaudeSession {
  id: string;
  title: string;
  startedAt: string | null;
  lastAt: string;
  bytes: number;
  gitBranch: string | null;
  version: string | null;
}

function firstPrompt(lines: Record<string, unknown>[]): string | null {
  for (const line of lines) {
    if (line.type !== 'user' || line.isSidechain === true) continue;
    const message = isRecord(line.message) ? line.message : {};
    const text = promptText(message.content);
    if (text !== null && !NOISE.some((n) => text.startsWith(n))) return text.slice(0, 120);
  }
  return null;
}

function promptText(content: unknown): string | null {
  if (typeof content === 'string') return content.trim() === '' ? null : content.trim();
  if (!Array.isArray(content)) return null;
  for (const block of content)
    if (isRecord(block) && block.type === 'text') {
      const text = str(block.text);
      if (text !== null) return text.trim();
    }
  return null;
}

function sessionOf(path: string, id: string, mtime: number, size: number): ClaudeSession {
  const head = readEdge(path, false);
  const tail = readEdge(path, true);
  const titled = [...tail].reverse().find((l) => l.type === 'ai-title' && str(l.aiTitle) !== null);
  const meta = head.find((l) => l.type === 'user' || l.type === 'assistant') ?? {};
  return {
    id,
    title: (titled === undefined ? null : str(titled.aiTitle)) ?? firstPrompt(head) ?? 'Untitled session',
    startedAt: str(head.find((l) => str(l.timestamp) !== null)?.timestamp) ?? null,
    lastAt: new Date(mtime).toISOString(),
    bytes: size,
    gitBranch: str(meta.gitBranch),
    version: str(meta.version),
  };
}

export function listClaudeSessions(project: string, dir = claudeDir()): ClaudeSession[] {
  const path = projectDir(project, dir);
  return sessionFiles(path).map((f) =>
    sessionOf(join(path, f.name), f.name.slice(0, -'.jsonl'.length), f.mtime, f.size),
  );
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

const cap = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max)}\n… (${String(text.length - max)} more characters)` : text;

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => (isRecord(b) && b.type === 'text' ? (str(b.text) ?? '') : ''))
    .filter((t) => t !== '')
    .join('\n');
}

function textBlock(raw: Record<string, unknown>): Block | null {
  const text = str(raw.text);
  if (text === null || NOISE.some((n) => text.startsWith(n))) return null;
  return { kind: 'text', text: cap(text, TEXT_CAP) };
}

const BLOCKS: Record<string, (raw: Record<string, unknown>) => Block | null> = {
  text: textBlock,
  tool_use: (raw) => ({
    kind: 'tool_use',
    name: str(raw.name) ?? 'tool',
    input: cap(JSON.stringify(raw.input ?? {}, null, 1), INPUT_CAP),
  }),
  tool_result: (raw) => ({
    kind: 'tool_result',
    text: cap(resultText(raw.content), RESULT_CAP),
    isError: raw.is_error === true,
  }),
  thinking: () => ({ kind: 'thinking' }),
  image: () => ({ kind: 'image' }),
};

function blockOf(raw: unknown): Block | null {
  if (!isRecord(raw) || typeof raw.type !== 'string') return null;
  const make = BLOCKS[raw.type];
  return make === undefined ? null : make(raw);
}

function entryOf(line: Record<string, unknown>): TranscriptEntry | null {
  if ((line.type !== 'user' && line.type !== 'assistant') || line.isSidechain === true) return null;
  const message = isRecord(line.message) ? line.message : {};
  const content = message.content;
  const blocks =
    typeof content === 'string'
      ? [blockOf({ type: 'text', text: content })]
      : Array.isArray(content)
        ? content.map(blockOf)
        : [];
  const kept = blocks.filter((b): b is Block => b !== null);
  if (kept.length === 0) return null;
  return { uuid: str(line.uuid) ?? '', at: str(line.timestamp), role: line.type, blocks: kept };
}

export async function readTranscript(
  project: string,
  session: string,
  offset: number,
  limit: number,
  dir = claudeDir(),
): Promise<TranscriptPage> {
  const path = join(projectDir(project, dir), `${safeName(session, SESSION_RE, 'session id')}.jsonl`);
  if (!existsSync(path)) throw new ApiError('no such session', 404);
  const entries: TranscriptEntry[] = [];
  let total = 0;
  const lines = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of lines) {
    const parsed = parseLines(line)[0];
    const entry = parsed === undefined ? null : entryOf(parsed);
    if (entry === null) continue;
    if (total >= offset && entries.length < limit) entries.push(entry);
    total += 1;
  }
  return { entries, total, next: offset + limit < total ? offset + limit : null };
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

function memoryDir(project: string, dir: string): string {
  return join(projectDir(project, dir), 'memory');
}

function readCapped(path: string): string {
  const size = statSync(path).size;
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(size, FILE_CAP));
    readSync(fd, buffer, 0, buffer.length, 0);
    return size > FILE_CAP ? `${buffer.toString('utf8')}\n\n… truncated` : buffer.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

export function listMemory(project: string, dir = claudeDir()): MemoryListing {
  const path = memoryDir(project, dir);
  if (!existsSync(path)) return { files: [], index: null };
  const files = readdirSync(path)
    .filter((name) => MEMORY_RE.test(name) && name !== 'MEMORY.md')
    .map((name) => {
      const s = statSync(join(path, name));
      return { name, bytes: s.size, modifiedAt: s.mtime.toISOString() };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  const index = join(path, 'MEMORY.md');
  return { files, index: existsSync(index) ? readCapped(index) : null };
}

export function readMemoryFile(project: string, name: string, dir = claudeDir()): string {
  const path = join(memoryDir(project, dir), safeName(name, MEMORY_RE, 'memory file name'));
  if (!existsSync(path)) throw new ApiError('no such memory file', 404);
  return readCapped(path);
}
