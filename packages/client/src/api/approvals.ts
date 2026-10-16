import { daemonBase } from '../auth/daemon.js';
import { call } from './client.js';
import { isRecord } from '../read.js';

export type Decision = 'allow' | 'deny';

export interface Approval {
  id: string;
  name: string;
  tool: string;
  preview: string;
  input: Record<string, unknown> | null;
  line: string;
  requestedAt: string;
  inChat: boolean;
  fileBytes: (number | null)[];
}

const METRO_TOOL = /^mcp__metro__(.+)$/;
const PREVIEW_MAX = 300;
const CODE_POINTS = /(?:\\n|\n)⋯ (\d+) code points elided ⋯(?:\\n|\n)/g;
const HIDDEN = /\uE000(\d+)\uE001/g;
const FIELD_BLOCK = /[\s,]*(?:\\n|\n)?\s*⋯[\s\S]*$/;

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

const toolLabel = (tool: string): string => METRO_TOOL.exec(tool)?.[1] ?? tool;

function record(json: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(json);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function previewInput(preview: string): Record<string, unknown> | null {
  const shown = preview.replace(CODE_POINTS, (_marker, count: string) => `\uE000${count}\uE001`);
  const whole = record(shown);
  if (whole !== null || !shown.includes('⋯')) return whole;
  const head = shown.replace(FIELD_BLOCK, '').replace(/[\s,]*$/, '');
  return record(`${head}}`) ?? record(head);
}

function visible(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(HIDDEN, '…');
  if (Array.isArray(value)) return value.map(visible);
  return isRecord(value) ? Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, visible(inner)])) : value;
}

function base64Bytes(data: string): number | null {
  let hidden = 0;
  const seen = data.replace(HIDDEN, (_marker, count: string) => {
    hidden += Number(count);
    return '';
  });
  if (seen.includes('…') || seen.includes('⋯')) return null;
  const encoded = seen.replace(/^data:[^,]*,/, '').replace(/\s/g, '');
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor(((encoded.length + hidden) * 3) / 4) - padding);
}

function fileBytes(input: Record<string, unknown> | null): (number | null)[] {
  const list: unknown[] = Array.isArray(input?.attachments) ? input.attachments : [];
  return list.map((raw) => (isRecord(raw) && typeof raw.data === 'string' && raw.data !== '' ? base64Bytes(raw.data) : null));
}

function previewOf(preview: string, input: Record<string, unknown> | null): string {
  const said = text(input?.text);
  const shown = said !== '' ? `"${said}"` : preview;
  return shown.length > PREVIEW_MAX ? `${shown.slice(0, PREVIEW_MAX)}…` : shown;
}

export function approvalOf(raw: unknown): Approval | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.tool !== 'string') return null;
  const parsed = previewInput(text(raw.preview));
  const shown = visible(parsed);
  const input = isRecord(shown) ? shown : null;
  const line = text(raw.line);
  return {
    id: raw.id,
    name: raw.tool,
    tool: toolLabel(raw.tool),
    preview: previewOf(text(raw.preview), input),
    input,
    line,
    requestedAt: text(raw.requestedAt),
    inChat: line !== '',
    fileBytes: fileBytes(parsed),
  };
}

const base = (daemon = daemonBase()): string => `${daemon}/api/approvals`;

export async function fetchApprovals(daemon?: string): Promise<Approval[]> {
  const body = await call({ method: 'GET', base: base(daemon) });
  if (!isRecord(body) || !Array.isArray(body.approvals)) throw new Error('Metro returned an unexpected response.');
  return body.approvals
    .flatMap((raw) => {
      const a = approvalOf(raw);
      return a === null ? [] : [a];
    })
    .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
}

export async function decideApproval(id: string, decision: Decision): Promise<void> {
  await call({
    method: 'POST',
    base: base(),
    path: `/${encodeURIComponent(id)}`,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ decision }),
  });
}
