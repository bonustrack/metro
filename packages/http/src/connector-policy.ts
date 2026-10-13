import { isRecord } from '@metro-labs/core/is-record';

export type ConnectorDecision = 'allow' | 'ask' | 'deny';

type ToolGroup = 'read' | 'write';

export interface ConnectorPolicy {
  read?: ConnectorDecision;
  write?: ConnectorDecision;
  tools?: Record<string, ConnectorDecision>;
}

export interface ConnectorPolicyLayers {
  organization: ConnectorPolicy;
  agent: ConnectorPolicy;
}

const RANK: Record<ConnectorDecision, number> = { allow: 0, ask: 1, deny: 2 };
const TOOL_RE = /^[A-Za-z0-9_.:/-]{1,256}$/;

export const validConnectorToolName = (name: string): boolean => TOOL_RE.test(name) && !['__proto__', 'constructor', 'prototype'].includes(name);

const decision = (value: unknown): value is ConnectorDecision => value === 'allow' || value === 'ask' || value === 'deny';

export function connectorPolicyOf(value: unknown): ConnectorPolicy {
  if (!isRecord(value) || Object.keys(value).some((key) => !['read', 'write', 'tools'].includes(key))) throw new Error('Invalid connector policy.');
  const out: ConnectorPolicy = {};
  for (const group of ['read', 'write'] as const) {
    if (!Object.hasOwn(value, group)) continue;
    const field = value[group];
    if (!decision(field)) throw new Error('Invalid connector policy.');
    out[group] = field;
  }
  if (Object.hasOwn(value, 'tools')) out.tools = toolPolicyOf(value.tools);
  return out;
}

function toolPolicyOf(value: unknown): Record<string, ConnectorDecision> {
  if (!isRecord(value) || Object.keys(value).length > 2000) throw new Error('Invalid connector policy.');
  const out: Record<string, ConnectorDecision> = {};
  for (const [name, rule] of Object.entries(value)) {
    if (!validConnectorToolName(name) || !decision(rule)) throw new Error('Invalid connector policy.');
    out[name] = rule;
  }
  return out;
}

export function connectorPolicyLayersOf(value: unknown): ConnectorPolicyLayers {
  if (!isRecord(value) || Object.keys(value).some((key) => !['organization', 'agent'].includes(key))) throw new Error('Invalid connector policy layers.');
  return { organization: connectorPolicyOf(value.organization), agent: connectorPolicyOf(value.agent) };
}

const strictest = (...values: (ConnectorDecision | undefined)[]): ConnectorDecision => values.reduce<ConnectorDecision>((held, next) => next !== undefined && RANK[next] > RANK[held] ? next : held, 'allow');
const toolRule = (policy: ConnectorPolicy, name: string): ConnectorDecision | undefined => policy.tools !== undefined && Object.hasOwn(policy.tools, name) ? policy.tools[name] : undefined;
const toolGroup = (groups: Record<string, ToolGroup>, name: string): ToolGroup => Object.hasOwn(groups, name) && groups[name] === 'read' ? 'read' : 'write';
const access = (policy: ConnectorPolicy, name: string, group: ToolGroup): ConnectorDecision => toolRule(policy, name) ?? policy[group] ?? 'allow';

export function combineConnectorPolicies(global: ConnectorPolicy, assignment: ConnectorPolicy, groups?: Record<string, ToolGroup>): ConnectorPolicy {
  const policies = [connectorPolicyOf(global), connectorPolicyOf(assignment)];
  const neutral = (policy: ConnectorPolicy): boolean => (policy.read ?? 'allow') === 'allow' && (policy.write ?? 'allow') === 'allow' && Object.keys(policy.tools ?? {}).length === 0;
  if (neutral(assignment)) return connectorPolicyOf(global);
  if (neutral(global)) return connectorPolicyOf(assignment);
  const out: ConnectorPolicy = {
    read: strictest(...policies.map((policy) => policy.read)),
    write: strictest(...policies.map((policy) => policy.write)),
  };
  const names = new Set(policies.flatMap((policy) => Object.keys(policy.tools ?? {})));
  if (groups === undefined && names.size > 2000) return { read: 'deny', write: 'deny' };
  if (names.size > 0) {
    out.tools = {};
    for (const name of names) {
      out.tools[name] = groups === undefined
        ? strictest(...policies.flatMap((policy) => [policy.read, policy.write, toolRule(policy, name)]))
        : strictest(...policies.map((policy) => access(policy, name, toolGroup(groups, name))));
    }
  }
  return out;
}

export function effectiveConnectorPolicy(row: { policy: ConnectorPolicy; policyLayers?: ConnectorPolicyLayers }, groups: Record<string, ToolGroup>): ConnectorPolicy {
  const layers = row.policyLayers;
  return layers === undefined ? connectorPolicyOf(row.policy) : combineConnectorPolicies(layers.organization, layers.agent, groups);
}

export function connectorPoliciesBlocked(layers: ConnectorPolicyLayers): boolean {
  const policies = [layers.organization, layers.agent];
  const names = new Set(policies.flatMap((policy) => Object.keys(policy.tools ?? {})));
  return (['read', 'write'] as const).every((group) =>
    strictest(...policies.map((policy) => policy[group])) === 'deny' &&
    [...names].every((name) => strictest(...policies.map((policy) => access(policy, name, group))) === 'deny'),
  );
}
