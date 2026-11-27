import { createHash } from 'node:crypto';
import { isRecord } from '@metro-labs/core/is-record';
import { errMsg, log } from '@metro-labs/core/log';
import { readJson, writeSecure } from '@metro-labs/core/secure-fs';
import { canonicalJson } from '@metro-labs/http/args-digest';
import { APPROVAL_ID_RE, APPROVAL_TTL_MS } from '@metro-labs/http/approval-rules';
import { mcpCallsOf, splitMcpTool, type McpApproval } from '@metro-labs/http/mcp-server-protocol';

const PREVIEW_MAX = 1000;
const MARK_MS = 10 * 60_000;
const KEPT_MAX = 5_000;
const MARK_RE = /^[A-Za-z0-9_-]{43}$/;

interface Kept {
  marks: Map<string, number>;
  asks: Map<string, number>;
}

let file: string | undefined;
let kept: Kept = { marks: new Map(), asks: new Map() };

export function serverPreview(args: Record<string, unknown>): string {
  const points = Array.from(canonicalJson(args));
  return points.length <= PREVIEW_MAX ? points.join('') : `${points.slice(0, PREVIEW_MAX - 1).join('')}…`;
}

const markOf = (tool: string, preview: string): string => createHash('sha256').update(`${tool}\n${preview}`, 'utf8').digest('base64url');

function trim(entries: Map<string, number>, ttl: number, now: number): void {
  for (const [key, at] of entries) if (now - at >= ttl || at > now) entries.delete(key);
  const oldest = [...entries].sort(([, a], [, b]) => a - b);
  for (const [key] of oldest.slice(0, Math.max(0, entries.size - KEPT_MAX))) entries.delete(key);
}

function prune(now: number): void {
  trim(kept.marks, MARK_MS, now);
  trim(kept.asks, APPROVAL_TTL_MS, now);
}

function save(): void {
  if (file === undefined) return;
  try {
    writeSecure(file, `${JSON.stringify({ version: 1, marks: Object.fromEntries(kept.marks), asks: Object.fromEntries(kept.asks) })}\n`);
  } catch (err) {
    log.warn({ err: errMsg(err) }, 'mcp-server: the chat calls could not be saved, so they are kept in memory only');
  }
}

function entriesOf(raw: unknown, re: RegExp): Map<string, number> {
  const out = new Map<string, number>();
  for (const [key, at] of Object.entries(isRecord(raw) ? raw : {})) if (re.test(key) && typeof at === 'number' && Number.isFinite(at)) out.set(key, at);
  return out;
}

const parse = (raw: unknown): Kept =>
  isRecord(raw) && raw.version === 1 ? { marks: entriesOf(raw.marks, MARK_RE), asks: entriesOf(raw.asks, APPROVAL_ID_RE) } : { marks: new Map(), asks: new Map() };

export function setChatMarksFile(path: string, now = Date.now()): void {
  file = path;
  kept = parse(readJson<unknown>(path, null, { warn: 'mcp-server: the chat calls file is not valid JSON, so it was ignored' }));
  prune(now);
}

function marksOf(args: Record<string, unknown>): string[] {
  try {
    return mcpCallsOf(args).flatMap((call) => (splitMcpTool(call.tool) === null ? [] : [markOf(call.tool, serverPreview(call.arguments))]));
  } catch (err) {
    log.debug({ err: errMsg(err) }, 'mcp-server: a chat tool_call named no call to mark');
    return [];
  }
}

export function markChatCalls(args: Record<string, unknown>, now = Date.now()): void {
  const marks = marksOf(args);
  if (marks.length === 0) return;
  for (const mark of marks) kept.marks.set(mark, now);
  prune(now);
  save();
}

export function askedByChat(approval: Pick<McpApproval, 'id' | 'connector' | 'tool' | 'preview'>, now = Date.now()): boolean {
  prune(now);
  if (kept.asks.has(approval.id)) return true;
  const mark = markOf(`${approval.connector}.${approval.tool}`, approval.preview);
  if (!kept.marks.delete(mark)) return false;
  kept.asks.set(approval.id, now);
  save();
  return true;
}

export function forgetChatMarks(): void {
  file = undefined;
  kept = { marks: new Map(), asks: new Map() };
}
