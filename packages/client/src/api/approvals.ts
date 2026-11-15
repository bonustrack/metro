import { daemonBase } from '../auth/daemon.js';
import { call } from './client.js';
import { isRecord, str } from '../read.js';

export type Decision = 'allow' | 'deny';

export interface Approval {
  id: string;
  name: string;
  tool: string;
  preview: string;
  request: string;
  input: Record<string, unknown> | null;
  line: string;
  requestedAt: string;
  inChat: boolean;
  fileBytes: (number | null)[];
  requestedBy: string | null;
}

const METRO_TOOL = /^mcp__metro__(.+)$/;
const PREVIEW_MAX = 300;
const CODE_POINTS = /(?:\\n|\n)⋯ (\d+) code points elided ⋯(?:\\n|\n)/g;
const HIDDEN = /\uE000(\d+)\uE001/g;
const REQUESTED_BY_MAX = 100;
const UNSEEN = /[\p{Cc}\u200b\u200e\u200f\u2028-\u202e\u2060-\u2069\ufeff]+/gu;


const toolLabel = (tool: string): string => METRO_TOOL.exec(tool)?.[1] ?? tool;

function record(json: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(json);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

const previewInput = (preview: string): Record<string, unknown> | null => record(preview.replace(CODE_POINTS, (_marker, count: string) => `\uE000${count}\uE001`));

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
  const said = str(input?.text);
  const shown = said !== '' ? `"${said}"` : preview;
  return shown.length > PREVIEW_MAX ? `${shown.slice(0, PREVIEW_MAX)}…` : shown;
}

function requestedByOf(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const flat = raw.replace(UNSEEN, ' ').replace(/\s+/g, ' ').trim();
  if (flat === '') return null;
  return flat.length > REQUESTED_BY_MAX ? `${flat.slice(0, REQUESTED_BY_MAX - 1).replace(/[\uD800-\uDBFF]$/, '').trimEnd()}…` : flat;
}

export function approvalOf(raw: unknown): Approval | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.tool !== 'string') return null;
  const request = str(raw.preview);
  const parsed = previewInput(request);
  const shown = visible(parsed);
  const input = isRecord(shown) ? shown : null;
  const line = str(raw.line);
  return {
    id: raw.id,
    name: raw.tool,
    tool: toolLabel(raw.tool),
    preview: previewOf(request, input),
    request,
    input,
    line,
    requestedAt: str(raw.requestedAt),
    inChat: line !== '',
    fileBytes: fileBytes(parsed),
    requestedBy: requestedByOf(raw.requestedBy),
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
