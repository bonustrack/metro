import { isRecord } from '@metro-labs/core/is-record';
import { str } from '@metro-labs/core/str';
import { readPreview, shownValue } from '../approvals/preview.js';
import { stationByName } from '../stations/registry.js';
import { stationOfAccount } from './read-tool.js';

export interface PermissionParams {
  request_id: string;
  tool_name: string;
  description: string;
  input_preview: string;
}

const METRO_TOOL = /^mcp__metro__(.+)$/;
const FIELD_MAX = 300;
const FIELD_CAPS = [FIELD_MAX, 120, 60];
const PROMPT_MAX = 1000;
const RAW_MAX = 600;
const TRAILER_ROOM = 160;
const NAMED_MAX = 5;
const FIRST = [
  'text', 'attachments', 'wallet', 'frame', 'speech', 'subject', 'reply_to', 'account', 'members', 'addresses', 'inboxIds', 'removeInboxIds', 'removeSelf',
  'message_id', 'emoji', 'name', 'bio', 'avatar', 'question', 'questions', 'options', 'query', 'from',
];
const PLACE = new Set(['line', 'station']);
const SOURCES = ['path', 'url', 'upload'] as const;

interface Field {
  key: string;
  text: string;
}

const shorten = (text: string, max = FIELD_MAX): string => {
  const shown = shownValue(text);
  return shown.length > max ? `${shown.slice(0, max)}…` : shown;
};

const plain = (value: unknown): value is string | number => typeof value === 'string' || typeof value === 'number';

function listText(list: unknown[]): string | undefined {
  if (list.length === 0) return undefined;
  return list.every(plain) ? list.join(', ') : `${String(list.length)} item(s)`;
}

function valueText(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() === '' ? undefined : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return Array.isArray(value) ? listText(value) : undefined;
}

function channelOf(input: Record<string, unknown>): string | undefined {
  const line = typeof input.line === 'string' ? input.line : '';
  const parts = line.split('/');
  if (line.startsWith('metro://') && parts[2] !== undefined) {
    const where = parts.slice(4).join('/');
    return where === '' ? parts[2] : `${parts[2]} · ${where}`;
  }
  return typeof input.station === 'string' && input.station !== '' ? input.station : undefined;
}

function discoveryChannel(input: Record<string, unknown>): string {
  const account = str(input.account);
  if (!account) return 'unknown account';
  const name = stationOfAccount(account);
  const station = name === undefined ? undefined : stationByName(name);
  return `${station?.name ?? 'unknown station'} · ${shorten(account)}`;
}

const empty = (value: object): boolean => (Array.isArray(value) ? value.length : Object.keys(value).length) === 0;

function argText(value: unknown): string | undefined {
  const shown = valueText(value);
  if (shown !== undefined || value === null || typeof value !== 'object') return shown;
  return empty(value) ? undefined : JSON.stringify(value);
}

function fileText(file: unknown): string {
  if (!isRecord(file)) return 'a file';
  const source = SOURCES.find((kind) => typeof file[kind] === 'string' && file[kind] !== '');
  if (source !== undefined) return `${source} ${str(file[source])}`;
  return typeof file.data === 'string' && file.data !== '' ? 'inline data' : 'a file';
}

function filesText(files: unknown[]): string {
  const named = files.map(fileText).filter((text) => text !== 'a file');
  return named.length === 0 ? `${String(files.length)} file(s)` : `${String(files.length)} file(s): ${files.map(fileText).join(', ')}`;
}

const fieldText = (key: string, value: unknown): string | undefined =>
  key === 'attachments' && Array.isArray(value) && value.length > 0 ? filesText(value) : argText(value);

function fieldsOf(tool: string, input: Record<string, unknown>): Field[] {
  const hidden = tool === 'list_channels' ? new Set([...PLACE, 'account']) : PLACE;
  const keys = [...FIRST.filter((key) => key in input), ...Object.keys(input).filter((key) => !FIRST.includes(key))];
  return keys.flatMap((key) => {
    const text = hidden.has(key) ? undefined : fieldText(key, input[key]);
    return text === undefined ? [] : [{ key, text }];
  });
}

const fieldLine = ({ key, text }: Field, cap: number): string => (key === 'text' ? `Text: "${shorten(text, cap)}"` : `${key}: ${shorten(text, cap)}`);

const sizeOf = (lines: string[]): number => lines.reduce((sum, line) => sum + line.length + 1, 0);

function notShown(keys: string[]): string {
  const named = keys.slice(0, NAMED_MAX).map((key) => shorten(key, 24)).join(', ');
  const more = keys.length > NAMED_MAX ? ` and ${String(keys.length - NAMED_MAX)} more` : '';
  return `Not shown here: ${named}${more}. Read it on metro.box before you answer.`;
}

function fitted(head: string[], fields: Field[], room: number): string[] {
  for (const cap of FIELD_CAPS) {
    const lines = [...head, ...fields.map((field) => fieldLine(field, cap))];
    if (sizeOf(lines) <= room) return lines;
  }
  const lines = [...head];
  const left: string[] = [];
  for (const field of fields) {
    const line = fieldLine(field, FIELD_CAPS.at(-1) ?? FIELD_MAX);
    if (left.length === 0 && sizeOf([...lines, line]) <= room - TRAILER_ROOM) lines.push(line);
    else left.push(field.key);
  }
  return [...lines, notShown(left)];
}

function metroLines(tool: string, input: Record<string, unknown>, room: number): string[] {
  const head = [`Approval needed: ${shorten(tool, 64)}`];
  const channel = tool === 'list_channels' ? discoveryChannel(input) : channelOf(input);
  if (channel !== undefined) head.push(`Channel: ${shorten(channel, 160)}`);
  if (tool === 'send' && input.speech !== undefined) head.push('Delivery: voice call only, no chat post');
  return fitted(head, fieldsOf(tool, input), room);
}

const ARGS_MAX = 8;

function argLines(input: Record<string, unknown> | undefined): string[] {
  const args = Object.entries(input ?? {}).flatMap(([key, value]) => {
    const text = argText(value);
    return text === undefined ? [] : [`${key}: ${shorten(text)}`];
  });
  return args.length > ARGS_MAX ? [...args.slice(0, ARGS_MAX), `(${String(args.length - ARGS_MAX)} more)`] : args;
}

const answerLine = (requestId: string): string => `Reply "yes ${requestId}" or "no ${requestId}"`;

const roomFor = (requestId: string): number => PROMPT_MAX - answerLine(requestId).length - 3;

function bodyLines(params: PermissionParams): string[] {
  const metro = METRO_TOOL.exec(params.tool_name)?.[1];
  const { input } = readPreview(params.input_preview);
  const raw = params.input_preview.trim() === '' ? [] : [shorten(params.input_preview, RAW_MAX)];
  if (metro !== undefined) return input === undefined ? [`Approval needed: ${shorten(metro, 64)}`, ...raw] : metroLines(metro, input, roomFor(params.request_id));
  return [`Claude wants to run ${params.tool_name}: ${shorten(params.description)}`, '', ...raw];
}

function withAnswer(requestId: string, lines: string[]): string {
  const body = lines.join('\n');
  const room = roomFor(requestId);
  return `${body.length > room ? `${body.slice(0, room)}…` : body}\n\n${answerLine(requestId)}`;
}

export function promptBody(params: PermissionParams): string {
  return withAnswer(params.request_id, bodyLines(params));
}

export interface ServerPrompt {
  requestId: string;
  tool: string;
  preview: string;
}

export function serverPromptBody(prompt: ServerPrompt): string {
  const { input } = readPreview(prompt.preview);
  const raw = prompt.preview.trim() === '' ? [] : [shorten(prompt.preview, RAW_MAX)];
  const args = input === undefined ? raw : argLines(input);
  return withAnswer(prompt.requestId, [`Approval needed: ${prompt.tool}`, ...args]);
}
