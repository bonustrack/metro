import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { isRecord } from './background.js';
import { nativeId, nativeToken, NATIVE_CURSOR_MAX, NATIVE_FILE_MAX, type NativeCursor, type NativeTaskStatus } from './native-recovery-state.js';

export const NATIVE_SCAN_BYTES = 256 * 1024;
export const NATIVE_LINE_BYTES = 64 * 1024;
const RECORD_MAX = 2048;
export type NativeEvent = {
  source: string | null;
  at: number;
  receipt: string;
} & (
  | { type: 'call'; tool: string; kind: 'Agent' | 'SendMessage' }
  | { type: 'result'; tool: string; outcome: Record<string, unknown> | null; failed: boolean }
  | { type: 'notification'; agent: string; tool: string | null; state: NativeTaskStatus }
  | { type: 'ack'; id: string }
);
export interface NativeScan { events: NativeEvent[]; files: NativeCursor[]; gaps: string[] }
interface NativeRows { rows: unknown[]; offset: number; incomplete: boolean }
type EventBase = Pick<NativeEvent, 'source' | 'at' | 'receipt'>;
type Notification = Pick<Extract<NativeEvent, { type: 'notification' }>, 'agent' | 'tool' | 'state'>;
type CallKind = 'Agent' | 'SendMessage';

function decodeRows(buffer: Buffer, start: number, end: number, read: NativeRows): NativeRows {
  const lines = buffer.subarray(start, end).toString('utf8').split('\n');
  for (const line of lines.slice(0, RECORD_MAX)) {
    if (line === '') continue;
    if (Buffer.byteLength(line) > NATIVE_LINE_BYTES) { read.incomplete = true; continue; }
    try { read.rows.push(JSON.parse(line)); } catch { read.incomplete = true; }
  }
  read.incomplete ||= lines.length > RECORD_MAX;
  return read;
}

function readRows(path: string, offset: number): NativeRows {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error('Native transcript is not a regular file');
    if (offset > stat.size) return { rows: [], offset, incomplete: true };
    const from = Math.max(offset, stat.size - NATIVE_SCAN_BYTES);
    const buffer = Buffer.alloc(Math.min(stat.size - from, NATIVE_SCAN_BYTES));
    const count = readSync(fd, buffer, 0, buffer.length, from);
    const end = buffer.lastIndexOf(10, count - 1);
    const incomplete = from > offset || count < buffer.length || end !== count - 1;
    if (count === 0) return { rows: [], offset: from, incomplete };
    if (end < 0) return { rows: [], offset: from, incomplete: true };
    const start = from > offset ? buffer.indexOf(10) + 1 : 0;
    return decodeRows(buffer, start, end, { rows: [], offset: from + end + 1, incomplete });
  } finally {
    closeSync(fd);
  }
}

function contentOf(row: Record<string, unknown>): unknown {
  return isRecord(row.message) ? row.message.content : undefined;
}

function textOf(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content) || content.length !== 1) return null;
  const block: unknown = content[0];
  return isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? block.text : null;
}

function resultOf(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) return value;
  if (typeof value !== 'string' || value.length > NATIVE_LINE_BYTES) return null;
  try { const raw: unknown = JSON.parse(value); return isRecord(raw) ? raw : null; } catch { return null; }
}

function tag(text: string, name: string): string | null | undefined {
  const matches = [...text.matchAll(new RegExp(`<${name}>([^<]*)</${name}>`, 'g'))];
  return matches.length > 1 ? undefined : matches[0]?.[1] ?? null;
}

function terminal(value: unknown, reason: unknown): NativeTaskStatus | null {
  if (value === 'stopped' && reason === 'worker_restart') return 'restarted';
  return value === 'completed' || value === 'failed' || value === 'stopped' ? value : null;
}

const queued = (row: Record<string, unknown>): Record<string, unknown> | null => isRecord(row.attachment) && row.attachment.type === 'queued_command' ? row.attachment : null;

function textNotification(row: Record<string, unknown>): Notification | null {
  const attachment = queued(row);
  const origin = attachment?.origin ?? row.origin;
  if (!isRecord(origin) || origin.kind !== 'task-notification') return null;
  if (row.type !== 'user' && row.type !== 'attachment') return null;
  const text = textOf(attachment?.value ?? contentOf(row));
  return text === null ? null : notificationTags(text.trim());
}

function notificationOf(agent: unknown, tool: unknown, status: unknown, reason: unknown): Notification | null {
  const state = terminal(status, reason);
  if (!nativeToken(agent) || state === null) return null;
  if (tool != null && !nativeToken(tool)) return null;
  return { agent, state, tool: nativeToken(tool) ? tool : null };
}

function notificationTags(text: string): Notification | null {
  const open = '<task-notification>';
  const close = '</task-notification>';
  if (!text.startsWith(open) || !text.endsWith(close)) return null;
  if (text.includes(open, 1) || text.indexOf(close) !== text.length - close.length) return null;
  const fields = ['task-id', 'tool-use-id', 'status', 'reason'].map((name) => tag(text, name));
  if (fields.some((field) => field === undefined)) return null;
  return notificationOf(fields[0], fields[1], fields[2], fields[3]);
}

function notification(row: Record<string, unknown>): Notification | null {
  if (row.type !== 'system' || row.subtype !== 'task_notification') return textNotification(row);
  return notificationOf(row.task_id, row.tool_use_id, row.status, row.reason);
}

function ackOf(block: Record<string, unknown>, base: EventBase): NativeEvent | null {
  if (block.type !== 'text' || typeof block.text !== 'string') return null;
  const match = /^METRO_RECOVERY_ACK ([a-f0-9]{64})$/.exec(block.text.trim());
  return nativeId(match?.[1]) ? { ...base, type: 'ack', id: match[1] } : null;
}

function callOf(block: Record<string, unknown>, base: EventBase): NativeEvent | null {
  if (block.type !== 'tool_use' || !nativeToken(block.id)) return null;
  return block.name === 'Agent' || block.name === 'SendMessage' ? { ...base, type: 'call', tool: block.id, kind: block.name } : null;
}

const rootAssistant = (row: Record<string, unknown>, base: EventBase): boolean => base.source === null && row.aborted !== true && row.parent_tool_use_id == null && row.parent_agent_id == null;

function blockEvent(block: unknown, row: Record<string, unknown>, base: EventBase, single: boolean): NativeEvent | null {
  if (!isRecord(block)) return null;
  if (row.type === 'assistant') {
    const ack = rootAssistant(row, base) ? ackOf(block, base) : null;
    return ack ?? callOf(block, base);
  }
  if (row.type !== 'user' || block.type !== 'tool_result' || !nativeToken(block.tool_use_id)) return null;
  return { ...base, type: 'result', tool: block.tool_use_id, failed: block.is_error === true, outcome: resultOf(single ? row.toolUseResult : null) ?? resultOf(block.content) };
}

const sidechain = (row: Record<string, unknown>, source: string | null): boolean => source === null && (row.isSidechain === true || typeof row.agentId === 'string');

function eventsOf(row: Record<string, unknown>, source: string | null): NativeEvent[] {
  if (sidechain(row, source)) return [];
  const at = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN;
  if (!Number.isSafeInteger(at) || at < 0 || !nativeToken(row.uuid)) return [];
  const base = { source, at, receipt: row.uuid };
  const end = notification(row);
  if (end !== null) return [{ ...base, type: 'notification', ...end }];
  const content = contentOf(row);
  const blocks: unknown[] = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
  return blocks.flatMap((block) => { const event = blockEvent(block, row, base, blocks.length === 1); return event === null ? [] : [event]; });
}

function resultChild(kind: CallKind | undefined, outcome: Record<string, unknown>): string | null {
  if (kind === 'Agent' && (outcome.status === 'async_launched' || outcome.status === 'completed')) return nativeToken(outcome.agentId) ? outcome.agentId : null;
  return kind === 'SendMessage' && outcome.success === true && nativeToken(outcome.resumedAgentId) ? outcome.resumedAgentId : null;
}

function childOf(event: NativeEvent, calls: Map<string, CallKind>): string | null {
  if (event.type === 'ack') return null;
  const key = `${event.source ?? ''}/${event.tool ?? ''}`;
  if (event.type === 'call') calls.set(key, event.kind);
  if (event.type === 'notification') return calls.has(key) ? event.agent : null;
  if (event.type !== 'result' || event.failed || event.outcome === null) return null;
  return resultChild(calls.get(key), event.outcome);
}

function missingEnvelope(row: Record<string, unknown>): boolean {
  const message = row.type === 'assistant' || row.type === 'user' || row.type === 'attachment' || row.subtype === 'task_notification';
  if (!message) return false;
  return !nativeToken(row.uuid) || typeof row.timestamp !== 'string' || !Number.isSafeInteger(Date.parse(row.timestamp));
}

function rowsOf(read: NativeRows, agent: string | null, owner: string): NativeEvent[] {
  const events: NativeEvent[] = [];
  for (const row of read.rows) {
    if (!isRecord(row)) { read.incomplete = true; continue; }
    if (agent === null && typeof row.sessionId === 'string' && row.sessionId !== owner) { read.incomplete = true; continue; }
    read.incomplete ||= missingEnvelope(row);
    events.push(...eventsOf(row, agent));
  }
  return events;
}

interface ScanContext {
  root: string;
  owner: string;
  calls: Map<string, CallKind>;
  pending: (string | null)[];
  files: Map<string | null, NativeCursor>;
  scan: NativeScan;
}

function discover(context: ScanContext, event: NativeEvent, index: number): void {
  const child = childOf(event, context.calls);
  if (child === null || context.pending.includes(child)) return;
  if (context.files.size >= NATIVE_CURSOR_MAX) { context.scan.gaps.push('file-capacity'); return; }
  context.files.set(child, { agent: child, offset: 0 });
  context.pending.splice(index + 1, 0, child);
}

function scanFile(context: ScanContext, agent: string | null, index: number): void {
  const { root, owner, files, scan } = context;
  const before = files.get(agent)?.offset ?? 0;
  const path = agent === null ? join(root, `${owner}.jsonl`) : join(root, owner, 'subagents', `agent-${agent}.jsonl`);
  files.delete(agent);
  try {
    const read = readRows(path, before);
    const events = rowsOf(read, agent, owner);
    files.set(agent, { agent, offset: read.offset });
    if (read.incomplete) scan.gaps.push(`${agent ?? 'root'}:${String(before)}`);
    for (const event of events) {
      discover(context, event, index);
      if (scan.events.length < RECORD_MAX) scan.events.push(event); else scan.gaps.push('event-capacity');
    }
  } catch {
    scan.gaps.push(`${agent ?? 'root'}:${String(before)}`);
    files.set(agent, { agent, offset: before });
  }
}

export function scanNative(root: string, owner: string, previous: NativeCursor[], knownCalls: { source: string | null; tool: string; kind: CallKind }[]): NativeScan {
  const pending: (string | null)[] = [null, ...previous.flatMap((file) => file.agent === null ? [] : [file.agent])];
  const files = new Map(previous.map((file) => [file.agent, file]));
  const calls = new Map(knownCalls.map((call) => [`${call.source ?? ''}/${call.tool}`, call.kind]));
  const scan: NativeScan = { events: [], files: [], gaps: [] };
  const context = { root, owner, calls, pending, files, scan };
  for (let i = 0; i < pending.length && i < NATIVE_FILE_MAX; i += 1) scanFile(context, pending[i] ?? null, i);
  if (pending.length > NATIVE_FILE_MAX) scan.gaps.push('file-budget');
  scan.files = [...files.values()];
  scan.gaps = [...new Set(scan.gaps)];
  scan.events.sort((a, b) => a.at - b.at);
  return scan;
}
