import { approvalCard } from '@metro-labs/client/api/approval-card';
import type { Approval } from '@metro-labs/client/api/approvals';
import { connectorOfKey } from '@metro-labs/client/api/connector-key';
import type { OrgConnectors } from '@metro-labs/client/api/org-connectors';
import { isRecord } from '@metro-labs/client/read';
import { isApprovalId } from '@metro-labs/client/route';
import { parsedInput } from './chat-words.js';

const TOOL_CALL = 'mcp__metro__tool_call';
const APPROVAL_LINK = /\/approvals\/([a-z]+)/g;

interface ConnectorCall {
  key: string;
  tool: string;
  more: number;
  arguments: string;
}

export function connectorCall(name: string, input: string): ConnectorCall | null {
  if (name !== TOOL_CALL) return null;
  const calls = parsedInput(input)?.calls;
  const first: unknown = Array.isArray(calls) ? calls[0] : undefined;
  const tool = isRecord(first) && typeof first.tool === 'string' ? first.tool : '';
  const dot = tool.indexOf('.');
  if (!isRecord(first) || dot <= 0) return null;
  return { key: tool.slice(0, dot), tool: tool.slice(dot + 1), more: (Array.isArray(calls) ? calls.length : 1) - 1, arguments: JSON.stringify(first.arguments ?? {}) };
}

export function waitingApprovals(name: string, result: string | null): string[] {
  if (name !== TOOL_CALL || result === null || !result.includes('needs_approval')) return [];
  return [...new Set([...result.matchAll(APPROVAL_LINK)].map((found) => found[1] ?? '').filter(isApprovalId))];
}

interface ConnectorsRead {
  data?: OrgConnectors | undefined;
  error: unknown;
}

export function chatApprovalTitle(approval: Approval, connectors: ConnectorsRead, agent: string): string | undefined {
  const card = approvalCard(approval);
  const tool = card.connectorTool ?? card.title;
  if (card.connector === null) return `The agent asks before it runs ${tool}`;
  if (connectors.data === undefined && connectors.error === null) return undefined;
  const named = connectors.data === undefined ? undefined : connectorOfKey(connectors.data.connectors, agent, card.connector);
  return `${named?.name ?? card.connector} asks before it runs ${tool}`;
}

const ELIDED = 'code points elided';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (!isRecord(value)) return JSON.stringify(value) ?? 'null';
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

const sameKeys = (a: Record<string, unknown>, b: Record<string, unknown>): boolean => canonical(Object.keys(a).sort()) === canonical(Object.keys(b).sort());

function sameArguments(args: unknown, approval: Approval): boolean {
  if (approval.input === null) return true;
  if (!isRecord(args)) return false;
  return approval.request.includes(ELIDED) ? sameKeys(args, approval.input) : canonical(args) === canonical(approval.input);
}

export function approvalOfCall(approval: Approval, input: string): boolean {
  const calls = parsedInput(input)?.calls;
  if (!Array.isArray(calls)) return false;
  return calls.some((call) => isRecord(call) && call.tool === approval.name && sameArguments(call.arguments ?? {}, approval));
}
