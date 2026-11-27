import { isRecord } from './is-record.js';

export const CHAT_TEXT_MAX = 20_000;
export const CHAT_TITLE_MAX = 80;
export const CHAT_PARTS_MAX = 300;
export const PART_TEXT_MAX = 100_000;
export const TOOL_TEXT_MAX = 4_000;
export const CHAT_ERROR_MAX = 500;

export type ApprovalState = 'waiting' | 'allowed' | 'denied';

export type ReplyState = 'done' | 'error' | 'stopped';

export interface ChatSender {
  name: string;
  email: string | null;
}

interface TextPart {
  type: 'text';
  text: string;
}

export interface ToolPart {
  type: 'tool';
  id: string;
  name: string;
  input: string;
  result: string | null;
  ok: boolean | null;
}

export interface ApprovalPart {
  type: 'approval';
  id: string;
  tool: string;
  input: string;
  state: ApprovalState;
}

export type ChatPart = TextPart | ToolPart | ApprovalPart;

export interface ChatReply {
  parts: ChatPart[];
  state: ReplyState;
  error: string | null;
  ms?: number;
}

export type TurnEvent =
  | { t: 'part'; n: number; part: ChatPart }
  | { t: 'delta'; n: number; d: string }
  | { t: 'done'; state: ReplyState; error: string | null };

const REPLY_STATES: ReadonlySet<string> = new Set(['done', 'error', 'stopped']);
const APPROVAL_STATES: ReadonlySet<string> = new Set(['waiting', 'allowed', 'denied']);
const NAME_RE = /^[A-Za-z0-9_:.-]{1,128}$/;
const NAME_MAX = 128;

export const CHAT_MCP_HEADER = 'x-metro-chat';

export const chatName = (raw: string): string => raw.replace(/[^A-Za-z0-9_:.-]/g, '_').slice(0, NAME_MAX) || '_';

export const chatLine = (value: unknown): string => `${JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')}\n`;

export const clip = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

export function chatTitleOf(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return clip(line === '' ? 'New chat' : line, CHAT_TITLE_MAX);
}

const str = (value: unknown, max: number): string | null => (typeof value === 'string' ? clip(value, max) : null);

const matching = (value: unknown, re: RegExp): string | null => (typeof value === 'string' && re.test(value) ? value : null);

function textPartOf(raw: Record<string, unknown>): TextPart | null {
  const text = str(raw.text, PART_TEXT_MAX);
  return text === null ? null : { type: 'text', text };
}

function toolPartOf(raw: Record<string, unknown>): ToolPart | null {
  const id = matching(raw.id, NAME_RE);
  const name = matching(raw.name, NAME_RE);
  const input = str(raw.input, TOOL_TEXT_MAX) ?? '';
  if (id === null || name === null) return null;
  const result = str(raw.result, TOOL_TEXT_MAX);
  const ok = typeof raw.ok === 'boolean' ? raw.ok : null;
  return { type: 'tool', id, name, input, result, ok };
}

function approvalPartOf(raw: Record<string, unknown>): ApprovalPart | null {
  const id = matching(raw.id, NAME_RE);
  const tool = matching(raw.tool, NAME_RE);
  const state = typeof raw.state === 'string' && APPROVAL_STATES.has(raw.state) ? (raw.state as ApprovalState) : null;
  if (id === null || tool === null || state === null) return null;
  return { type: 'approval', id, tool, input: str(raw.input, TOOL_TEXT_MAX) ?? '', state };
}

export function chatPartOf(raw: unknown): ChatPart | null {
  if (!isRecord(raw)) return null;
  if (raw.type === 'text') return textPartOf(raw);
  if (raw.type === 'tool') return toolPartOf(raw);
  return raw.type === 'approval' ? approvalPartOf(raw) : null;
}

export const replyStateOf = (value: unknown): ReplyState | null =>
  typeof value === 'string' && REPLY_STATES.has(value) ? (value as ReplyState) : null;

export function chatReplyOf(raw: unknown): ChatReply | null {
  if (!isRecord(raw) || !Array.isArray(raw.parts) || raw.parts.length > CHAT_PARTS_MAX) return null;
  const state = replyStateOf(raw.state);
  const parts = raw.parts.map(chatPartOf);
  if (state === null || parts.some((part) => part === null)) return null;
  const ms = typeof raw.ms === 'number' && Number.isInteger(raw.ms) && raw.ms >= 0 ? { ms: raw.ms } : {};
  return { parts: parts.filter((part): part is ChatPart => part !== null), state, error: str(raw.error, CHAT_ERROR_MAX), ...ms };
}

function withDelta(part: ChatPart | undefined, d: string): ChatPart | null {
  if (part?.type !== 'text') return null;
  return { type: 'text', text: clip(part.text + d, PART_TEXT_MAX) };
}

export function applyTurnEvent(parts: readonly ChatPart[], event: TurnEvent): ChatPart[] {
  if (event.t === 'done' || event.n < 0 || event.n > parts.length || event.n >= CHAT_PARTS_MAX) return [...parts];
  const next = event.t === 'part' ? event.part : withDelta(parts[event.n], event.d);
  if (next === null) return [...parts];
  const copy = [...parts];
  copy[event.n] = next;
  return copy;
}

const PLACEHOLDER: ChatPart = { type: 'text', text: '' };

const partEventOf = (raw: Record<string, unknown>, n: number): TurnEvent => ({ t: 'part', n, part: chatPartOf(raw.part) ?? PLACEHOLDER });

function doneEventOf(raw: Record<string, unknown>): TurnEvent | null {
  const state = replyStateOf(raw.state);
  return state === null ? null : { t: 'done', state, error: str(raw.error, CHAT_ERROR_MAX) };
}

export function turnEventOf(raw: unknown): TurnEvent | null {
  if (!isRecord(raw)) return null;
  if (raw.t === 'done') return doneEventOf(raw);
  const n = typeof raw.n === 'number' && Number.isInteger(raw.n) && raw.n >= 0 ? raw.n : null;
  if (n === null) return null;
  if (raw.t === 'part') return partEventOf(raw, n);
  return raw.t === 'delta' && typeof raw.d === 'string' ? { t: 'delta', n, d: clip(raw.d, PART_TEXT_MAX) } : null;
}

const REPLY_BYTES_MAX = 400_000;

const replySize = (reply: ChatReply): number => new TextEncoder().encode(JSON.stringify(reply)).length;

function shrinkTools(parts: ChatPart[], max: number): ChatPart[] {
  return parts.map((part) => {
    if (part.type === 'text') return part;
    if (part.type === 'approval') return { ...part, input: clip(part.input, max) };
    return { ...part, input: clip(part.input, max), result: part.result === null ? null : clip(part.result, max) };
  });
}

export function fitReply(reply: ChatReply, max = REPLY_BYTES_MAX): ChatReply {
  let fitted = reply;
  for (const limit of [1_000, 200]) {
    if (replySize(fitted) <= max) return fitted;
    fitted = { ...fitted, parts: shrinkTools(fitted.parts, limit) };
  }
  while (replySize(fitted) > max && fitted.parts.length > 1) fitted = { ...fitted, parts: fitted.parts.slice(1) };
  if (replySize(fitted) <= max) return fitted;
  return { ...fitted, parts: fitted.parts.map((part) => (part.type === 'text' ? { ...part, text: clip(part.text, max / 8) } : part)) };
}
