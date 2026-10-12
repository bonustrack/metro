import { isRecord } from '@metro-labs/core/is-record';

export type ConnectorDecision = 'allow' | 'ask' | 'deny';

export interface ConnectorPolicy {
  read?: ConnectorDecision;
  write?: ConnectorDecision;
  tools?: Record<string, ConnectorDecision>;
}

const RANK: Record<ConnectorDecision, number> = { allow: 0, ask: 1, deny: 2 };
const TOOL_RE = /^[A-Za-z0-9_.:/-]{1,256}$/;

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
    if (!TOOL_RE.test(name) || ['__proto__', 'constructor', 'prototype'].includes(name) || !decision(rule)) throw new Error('Invalid connector policy.');
    out[name] = rule;
  }
  return out;
}

const strictest = (...values: (ConnectorDecision | undefined)[]): ConnectorDecision => values.reduce<ConnectorDecision>((held, next) => next !== undefined && RANK[next] > RANK[held] ? next : held, 'allow');

export function combineConnectorPolicies(global: ConnectorPolicy, assignment: ConnectorPolicy): ConnectorPolicy {
  const policies = [connectorPolicyOf(global), connectorPolicyOf(assignment)];
  const neutral = (policy: ConnectorPolicy): boolean => (policy.read ?? 'allow') === 'allow' && (policy.write ?? 'allow') === 'allow' && Object.keys(policy.tools ?? {}).length === 0;
  if (neutral(assignment)) return connectorPolicyOf(global);
  if (neutral(global)) return connectorPolicyOf(assignment);
  const out: ConnectorPolicy = {
    read: strictest(...policies.map((policy) => policy.read)),
    write: strictest(...policies.map((policy) => policy.write)),
  };
  const names = new Set(policies.flatMap((policy) => Object.keys(policy.tools ?? {})));
  if (names.size > 0) {
    out.tools = {};
    for (const name of names) out.tools[name] = strictest(...policies.flatMap((policy) => [policy.read, policy.write, policy.tools?.[name]]));
  }
  return out;
}
