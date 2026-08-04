import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { eventInScope } from '../db/agent-scope.js';
import { str } from './str.js';

export interface FrameOrigin {
  line: string | undefined;
  owner: Set<number>;
}

export function frameLine(message: JSONRPCMessage): string | undefined {
  const params: unknown = (message as { params?: unknown }).params;
  if (typeof params !== 'object' || params === null) return undefined;
  const meta: unknown = (params as { meta?: unknown }).meta;
  if (typeof meta !== 'object' || meta === null) return undefined;
  return str((meta as { line?: unknown }).line) || undefined;
}

export function frameInScope(scope: Set<number>, origin: FrameOrigin): boolean {
  if (origin.line !== undefined) return eventInScope(scope, origin.line);
  return origin.owner.size > 0 && [...origin.owner].every((id) => scope.has(id));
}
