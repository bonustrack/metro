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
}

const METRO_TOOL = /^mcp__metro__(.+)$/;
const PREVIEW_MAX = 300;
const CODE_POINTS = /(?:\\n|\n)⋯ \d+ code points elided ⋯(?:\\n|\n)/g;
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
  const shown = preview.replace(CODE_POINTS, '…');
  const whole = record(shown);
  if (whole !== null || !shown.includes('⋯')) return whole;
  const head = shown.replace(FIELD_BLOCK, '').replace(/[\s,]*$/, '');
  return record(`${head}}`) ?? record(head);
}

function previewOf(preview: string, input: Record<string, unknown> | null): string {
  const said = text(input?.text);
  const shown = said !== '' ? `"${said}"` : preview;
  return shown.length > PREVIEW_MAX ? `${shown.slice(0, PREVIEW_MAX)}…` : shown;
}

export function approvalOf(raw: unknown): Approval | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.tool !== 'string') return null;
  const input = previewInput(text(raw.preview));
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
