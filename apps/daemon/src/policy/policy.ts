import { ApiError } from '@metro-labs/http/api-error';
import { isRecord } from '@metro-labs/core/is-record';
import { log } from '@metro-labs/core/log';
import type { ToolGroup } from '@metro-labs/core/stations/types';

export type Access = 'allow' | 'ask' | 'deny';

export const ACCESS: readonly Access[] = ['allow', 'ask', 'deny'];

export interface ToolPolicy {
  read?: Access;
  write?: Access;
  tools?: Record<string, Access>;
}

export type PolicyTarget =
  | { kind: 'channel'; station: string; account: string }
  | { kind: 'connector'; id: string };

export interface PolicyTool {
  name: string;
  group: ToolGroup;
}

const TOOL_NAME_RE = /^[A-Za-z0-9_.-]{1,128}$/;
const MAX_TOOLS = 500;
const RANK: Record<Access, number> = { allow: 0, ask: 1, deny: 2 };

const isAccess = (value: unknown): value is Access => typeof value === 'string' && (ACCESS as readonly string[]).includes(value);

export const targetKey = (target: PolicyTarget): string =>
  target.kind === 'channel' ? `channel:${target.station}/${target.account}` : `connector:${target.id}`;

export function decide(policy: ToolPolicy | undefined, tool: PolicyTool): Access {
  return policy?.tools?.[tool.name] ?? policy?.[tool.group] ?? 'allow';
}

export function strictest(list: readonly Access[]): Access {
  return list.reduce<Access>((worst, a) => (RANK[a] > RANK[worst] ? a : worst), 'allow');
}

function tolerantTools(raw: unknown, where: string): Record<string, Access> | undefined {
  const kept: Record<string, Access> = {};
  for (const [name, value] of Object.entries(isRecord(raw) ? raw : {})) {
    if (TOOL_NAME_RE.test(name) && isAccess(value)) kept[name] = value;
    else log.warn({ where, tool: name }, 'policy: a tool entry is not valid, ignored');
  }
  return Object.keys(kept).length > 0 ? kept : undefined;
}

export function parsePolicy(raw: unknown, where: string): ToolPolicy | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isRecord(raw)) {
    log.warn({ where }, 'policy: not an object, ignored');
    return undefined;
  }
  const out: ToolPolicy = {};
  for (const group of ['read', 'write'] as const) {
    const value = raw[group];
    if (isAccess(value)) out[group] = value;
    else if (value !== undefined) log.warn({ where, group, value }, 'policy: a group value is not allow, ask or deny, ignored');
  }
  const tools = tolerantTools(raw.tools, where);
  if (tools !== undefined) out.tools = tools;
  return out;
}

function strictAccess(value: unknown, what: string): Access | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isAccess(value)) throw new ApiError(`${what} must be allow, ask or deny`, 400);
  return value;
}

function strictTools(raw: unknown): Record<string, Access> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isRecord(raw)) throw new ApiError('policy.tools must be an object', 400);
  const entries = Object.entries(raw);
  if (entries.length > MAX_TOOLS) throw new ApiError(`policy.tools holds at most ${String(MAX_TOOLS)} tools`, 400);
  const tools: Record<string, Access> = {};
  for (const [name, value] of entries) {
    if (!TOOL_NAME_RE.test(name)) throw new ApiError(`'${name}' is not a tool name`, 400);
    const access = strictAccess(value, name);
    if (access !== undefined) tools[name] = access;
  }
  return Object.keys(tools).length > 0 ? tools : undefined;
}

export function normalizePolicy(raw: unknown): ToolPolicy {
  if (!isRecord(raw)) throw new ApiError('policy must be an object', 400);
  const read = strictAccess(raw.read, 'read');
  const write = strictAccess(raw.write, 'write');
  const tools = strictTools(raw.tools);
  return {
    ...(read === undefined ? {} : { read }),
    ...(write === undefined ? {} : { write }),
    ...(tools === undefined ? {} : { tools }),
  };
}

const stored = new Map<string, { target: PolicyTarget; policy: ToolPolicy }>();
const listeners = new Set<() => void>();

export function onPoliciesChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setPolicies(kind: PolicyTarget['kind'], entries: readonly (readonly [PolicyTarget, ToolPolicy])[]): void {
  for (const key of [...stored.keys()]) if (key.startsWith(`${kind}:`)) stored.delete(key);
  for (const [target, policy] of entries) if (target.kind === kind) stored.set(targetKey(target), { target, policy });
  for (const listener of listeners) listener();
}

export const storedPolicies = (): { target: PolicyTarget; policy: ToolPolicy }[] => [...stored.values()];

export const storedPolicy = (target: PolicyTarget): ToolPolicy | undefined => stored.get(targetKey(target))?.policy;

export const policyFor = (target: PolicyTarget, tool: PolicyTool): Access => decide(storedPolicy(target), tool);
