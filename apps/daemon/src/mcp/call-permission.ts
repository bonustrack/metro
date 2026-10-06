import { callRoute, speechTarget, type CallSource } from '@metro-labs/core/call';
import { isRecord } from '@metro-labs/core/is-record';
import { readPreview } from '../approvals/preview.js';
import { sharedCalls } from '../voice/shared.js';
import { agentIdForLine } from '../agents/map.js';

function boundCall(value: unknown, inScope: (line: string) => boolean): CallSource | null {
  if (!isRecord(value)) return null;
  const route = callRoute(value.route);
  const sourceId = value.sourceId;
  if (route === null || typeof sourceId !== 'string') return null;
  const source = { route, sourceId };
  return inScope(route.line) && sharedCalls.valid(source) ? source : null;
}

export function permissionCall(params: { call?: unknown; input_preview: string; tool_name: string }, inScope: (line: string) => boolean): CallSource | null | undefined {
  if (params.call !== undefined) return boundCall(params.call, inScope);
  if (params.tool_name !== 'mcp__metro__send') return undefined;
  const { input } = readPreview(params.input_preview);
  if (!isRecord(input) || input.speech === undefined) return undefined;
  const target = speechTarget(input.speech);
  if (target === null || typeof input.line !== 'string' || !inScope(input.line)) return null;
  const agentId = agentIdForLine(input.line);
  return agentId === undefined ? null : sharedCalls.source(input.line, target, new Set([agentId]));
}
