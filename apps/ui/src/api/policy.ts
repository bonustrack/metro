import { isRecord } from './read.js';


export type Access = 'allow' | 'ask' | 'deny';
export type ToolGroup = 'read' | 'write';

export const ACCESS_CHOICES: readonly Access[] = ['allow', 'ask', 'deny'];

export const ACCESS_LABEL: Record<Access, string> = {
  allow: 'Allow',
  ask: 'Ask first',
  deny: 'Block',
};

export const GROUP_LABEL: Record<ToolGroup, string> = {
  read: 'Read',
  write: 'Write',
};

export interface ToolPolicy {
  read?: Access;
  write?: Access;
  tools?: Record<string, Access>;
}

export interface GroupedTool {
  name: string;
  group: ToolGroup;
}

const isAccess = (value: unknown): value is Access => value === 'allow' || value === 'ask' || value === 'deny';

export function policyOf(value: unknown): ToolPolicy {
  if (!isRecord(value)) return {};
  const out: ToolPolicy = {};
  if (isAccess(value.read)) out.read = value.read;
  if (isAccess(value.write)) out.write = value.write;
  if (isRecord(value.tools)) {
    const tools: Record<string, Access> = {};
    for (const [name, access] of Object.entries(value.tools)) if (isAccess(access)) tools[name] = access;
    if (Object.keys(tools).length > 0) out.tools = tools;
  }
  return out;
}

export function toolGroupsOf(value: unknown): Record<string, GroupedTool[]> {
  if (!isRecord(value)) return {};
  const out: Record<string, GroupedTool[]> = {};
  for (const [station, list] of Object.entries(value))
    out[station] = Array.isArray(list)
      ? list.flatMap((t) =>
          isRecord(t) && typeof t.name === 'string' && (t.group === 'read' || t.group === 'write')
            ? [{ name: t.name, group: t.group }]
            : [],
        )
      : [];
  return out;
}

export const groupAccess = (policy: ToolPolicy, group: ToolGroup): Access => policy[group] ?? 'allow';

export const toolOverride = (policy: ToolPolicy, name: string): Access | undefined => policy.tools?.[name];

export const effectiveAccess = (policy: ToolPolicy, tool: GroupedTool): Access =>
  toolOverride(policy, tool.name) ?? groupAccess(policy, tool.group);

export const withGroup = (policy: ToolPolicy, group: ToolGroup, access: Access): ToolPolicy => ({ ...policy, [group]: access });

export function withTool(policy: ToolPolicy, name: string, access: Access | undefined): ToolPolicy {
  const tools: Record<string, Access> = Object.fromEntries(Object.entries(policy.tools ?? {}).filter(([tool]) => tool !== name));
  if (access !== undefined) tools[name] = access;
  const next: ToolPolicy = { ...policy };
  delete next.tools;
  if (Object.keys(tools).length > 0) next.tools = tools;
  return next;
}

export const toolsIn = (tools: GroupedTool[], group: ToolGroup): GroupedTool[] => tools.filter((t) => t.group === group);

export const connectorToolGroups = (tools: readonly { name: string; readOnly: boolean }[]): GroupedTool[] =>
  tools.map((tool) => ({ name: tool.name, group: tool.readOnly ? 'read' : 'write' }));
