import { daemonBase } from '../auth/daemon.js';
import { call } from './client.js';
import { isRecord } from './read.js';

export type Decision = 'allow' | 'deny';

export interface Approval {
  id: string;
  tool: string;
  channel: string;
  preview: string;
  requestedAt: string;
  inChat: boolean;
}

const METRO_TOOL = /^mcp__metro__(.+)$/;
const PREVIEW_MAX = 300;

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

const toolLabel = (tool: string): string => METRO_TOOL.exec(tool)?.[1] ?? tool;

const stationOfLine = (line: string): string => (line.startsWith('metro://') ? (line.split('/')[2] ?? '') : '');

function channelOf(line: string, input: Record<string, unknown> | null): string {
  return stationOfLine(text(input?.line)) || text(input?.station) || stationOfLine(line);
}

function parsed(preview: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(preview);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function previewOf(preview: string, input: Record<string, unknown> | null): string {
  const said = text(input?.text);
  const shown = said !== '' ? `"${said}"` : preview;
  return shown.length > PREVIEW_MAX ? `${shown.slice(0, PREVIEW_MAX)}…` : shown;
}

export function approvalOf(raw: unknown): Approval | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.tool !== 'string') return null;
  const input = parsed(text(raw.preview));
  const line = text(raw.line);
  return {
    id: raw.id,
    tool: toolLabel(raw.tool),
    channel: channelOf(line, input),
    preview: previewOf(text(raw.preview), input),
    requestedAt: text(raw.requestedAt),
    inChat: line !== '',
  };
}

const base = (): string => `${daemonBase()}/api/approvals`;

export async function fetchApprovals(): Promise<Approval[]> {
  const body = await call({ method: 'GET', base: base() });
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
