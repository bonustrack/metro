import { approvalFields, oneLine, type ApprovalField } from '@metro-labs/core/approval-fields';
import { str } from '@metro-labs/core/str';
import { previewInput } from '../approvals/preview.js';
import { stationByName } from '../stations/registry.js';
import { stationOfAccount } from './read-tool.js';

export interface PermissionParams {
  request_id: string;
  tool_name: string;
  description: string;
  input_preview: string;
}

export interface ServerPrompt {
  requestId: string;
  tool: string;
  preview: string;
}

const METRO_TOOL = /^mcp__metro__([\w-]+)$/;
const PROMPT_MAX = 1000;
const FIELD_MAX = 300;
const FIELD_MIN = 24;
const HEAD_MAX = 160;
const KEY_MAX = 24;
const TRAILER_ROOM = 80;
const PLACE = new Set(['line', 'station']);

function clip(text: string, max: number): string {
  const flat = oneLine(text);
  if (flat.length <= max) return flat;
  const tail = Math.floor(max / 3);
  return `${flat.slice(0, max - tail - 1)}…${flat.slice(-tail)}`;
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
  return `${station?.name ?? 'unknown station'} · ${account}`;
}

const fieldLine = ({ key, text }: ApprovalField, room: number): string => {
  const label = key === 'text' ? 'Text' : clip(key, KEY_MAX);
  const value = clip(text, Math.min(FIELD_MAX, room - label.length - 4));
  return key === 'text' ? `${label}: "${value}"` : `${label}: ${value}`;
};

const sizeOf = (lines: string[]): number => lines.reduce((sum, line) => sum + line.length + 1, 0);

function fitted(head: string[], fields: ApprovalField[], room: number, reserve = 0): string[] {
  const lines = [...head];
  let left = room - sizeOf(head) - reserve;
  for (const [at, field] of fields.entries()) {
    const share = at === fields.length - 1 ? left : Math.floor(left / 2);
    if (share < FIELD_MIN + KEY_MAX) break;
    lines.push(fieldLine(field, share));
    left -= (lines.at(-1)?.length ?? 0) + 1;
  }
  const hidden = fields.length - (lines.length - head.length);
  if (hidden === 0) return lines;
  return reserve === 0 ? fitted(head, fields, room, TRAILER_ROOM) : [...lines, `Not shown here: ${String(hidden)} more. Read it all on metro.box before you answer.`];
}

function metroHead(tool: string, input: Record<string, unknown>): string[] {
  const head = [`Approval needed: ${clip(tool, HEAD_MAX)}`];
  const channel = tool === 'list_channels' ? discoveryChannel(input) : channelOf(input);
  if (channel !== undefined) head.push(`Channel: ${clip(channel, HEAD_MAX)}`);
  if (tool === 'send' && input.speech !== undefined) head.push('Delivery: voice call only, no chat post');
  return head;
}

function question(requestId: string, head: string[], fields: ApprovalField[]): string {
  const answer = `Reply "yes ${requestId}" or "no ${requestId}"`;
  return `${fitted(head, fields, PROMPT_MAX - answer.length - 2).join('\n')}\n\n${answer}`;
}

const fieldsOf = (preview: string): ApprovalField[] => approvalFields(previewInput(preview) ?? { arguments: preview });

export function channelQuestion(requestId: string, tool: string, args: Record<string, unknown>): string {
  const hidden = tool === 'list_channels' ? new Set([...PLACE, 'account']) : PLACE;
  return question(requestId, metroHead(tool, args), approvalFields(args).filter((field) => !hidden.has(field.key)));
}

export function promptBody(params: PermissionParams): string {
  const metro = METRO_TOOL.exec(params.tool_name)?.[1];
  const input = previewInput(params.input_preview);
  if (metro !== undefined && input !== undefined) return channelQuestion(params.request_id, metro, input);
  const head = metro === undefined ? `Claude wants to run ${clip(params.tool_name, HEAD_MAX)}: ${clip(params.description, FIELD_MAX)}` : `Approval needed: ${clip(metro, HEAD_MAX)}`;
  return question(params.request_id, [head], fieldsOf(params.input_preview));
}

export const serverPromptBody = (prompt: ServerPrompt): string =>
  question(prompt.requestId, [`Approval needed: ${clip(prompt.tool, HEAD_MAX)}`], fieldsOf(prompt.preview));
