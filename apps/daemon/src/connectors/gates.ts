import type { ToolGroup } from '@metro-labs/core/stations/types';
import { decide, policyFor, setPolicies, type PolicyTarget, type ToolPolicy } from '../policy/policy.js';
import { serverKeysOf } from './plugin-sync.js';
import { NEEDS_APPROVAL, revokeToolPrompts, settlePrompts, takeGrant } from '../approvals/pending.js';
import { isOrgRelayId } from './relay-id.js';
import type { BlockedReason } from './relay-policy.js';

export interface GateRow {
  id: string;
  name: string;
  config: { policy?: ToolPolicy; toolGroups?: Record<string, ToolGroup> };
}

export interface ConnectorGate {
  id: string;
  name: string;
  server: string;
  policy: ToolPolicy;
  tools: Record<string, ToolGroup>;
}

let gates: ConnectorGate[] = [];

const normalized = (name: string): string => name.replace(/[^a-zA-Z0-9_-]/g, '_');

function approvalChanged(gate: ConnectorGate, tool: string, next: GateRow | undefined, keys: ReadonlyMap<string, string>): boolean {
  if (next === undefined || gate.server !== keys.get(gate.id) || JSON.stringify([gate.name, gate.policy]) !== JSON.stringify([next.name, next.config.policy ?? {}])) return true;
  const before = decide(gate.policy, { name: tool, group: toolGroupOf(gate, tool) });
  const after = decide(next.config.policy, { name: tool, group: next.config.toolGroups?.[tool] === 'read' ? 'read' : 'write' });
  return before !== after;
}

export function registerConnectors(rows: readonly GateRow[], keys: ReadonlyMap<string, string> = serverKeysOf([...rows])): void {
  const next = rows.map((row) => ({
    id: row.id,
    name: row.name,
    server: keys.get(row.id) ?? '',
    policy: row.config.policy ?? {},
    tools: row.config.toolGroups ?? {},
  }));
  revokeToolPrompts((tool) => {
    const before = connectorToolOf(tool);
    const after = connectorToolOf(tool, next);
    if (before?.gate.id !== after?.gate.id) return true;
    return before !== undefined && approvalChanged(before.gate, before.tool, rows.find((row) => row.id === before.gate.id), keys);
  });
  gates = next;
  const entries = rows.flatMap((row): [PolicyTarget, ToolPolicy][] =>
    row.config.policy === undefined ? [] : [[{ kind: 'connector', id: row.id }, row.config.policy]],
  );
  setPolicies('connector', entries);
}

export const connectorGates = (): readonly ConnectorGate[] => gates;

export const toolGroupOf = (gate: ConnectorGate, tool: string): ToolGroup => (gate.tools[tool] === 'read' ? 'read' : 'write');

const promptFor = (connectorId: string, tool: string) => (asked: string): boolean => {
  const found = connectorToolOf(asked);
  return found?.gate.id === connectorId && found.tool === tool;
};

export function blockedReason(connectorId: string, tool: string, args: Record<string, unknown> = {}): string | null {
  const gate = gates.find((g) => g.id === connectorId);
  if (gate === undefined) return 'This connector is not available.';
  settlePrompts(promptFor(connectorId, tool), args);
  const access = policyFor({ kind: 'connector', id: connectorId }, { name: tool, group: toolGroupOf(gate, tool) });
  if (access === 'deny') return `Blocked by the owner's policy for ${gate.name} (${tool}).`;
  if (access === 'allow' || takeGrant(promptFor(connectorId, tool), args)) return null;
  return NEEDS_APPROVAL(gate.name, tool);
}

export function requestConnectorBlocker(): () => BlockedReason {
  const permits = new Map<string, number>();
  return () => {
    const seen = new Map<string, number>();
    return (id, tool, args) => {
      const gate = gates.find((entry) => entry.id === id);
      if (gate === undefined) return 'This organization connector is not available.';
      const group = toolGroupOf(gate, tool);
      const access = policyFor({ kind: 'connector', id }, { name: tool, group });
      if (access !== 'ask') return blockedReason(id, tool, args);
      const key = JSON.stringify([id, gate.server, gate.policy, group, tool, args]);
      const occurrence = seen.get(key) ?? 0;
      seen.set(key, occurrence + 1);
      if (occurrence < (permits.get(key) ?? 0)) return null;
      const reason = blockedReason(id, tool, args);
      if (reason === null) permits.set(key, (permits.get(key) ?? 0) + 1);
      return reason;
    };
  };
}

function resolvedTool(gate: ConnectorGate, called: string): { gate: ConnectorGate; tool: string } {
  const known = [...Object.keys(gate.tools), ...Object.keys(gate.policy.tools ?? {})];
  return { gate, tool: known.find((name) => name === called) ?? known.find((name) => normalized(name) === called) ?? called };
}

export function connectorToolOf(toolName: string, entries: readonly ConnectorGate[] = gates): { gate: ConnectorGate; tool: string } | undefined {
  if (toolName.startsWith('mcp__metro__')) return undefined;
  for (const gate of entries)
    for (const prefix of [`mcp__plugin_metro_${gate.server}__`, `mcp__${gate.server}__`])
      if (toolName.startsWith(prefix) && toolName.length > prefix.length) return resolvedTool(gate, toolName.slice(prefix.length));
  return legacyToolOf(toolName, entries);
}

function legacyToolOf(toolName: string, entries: readonly ConnectorGate[]): { gate: ConnectorGate; tool: string } | undefined {
  if (!toolName.startsWith('mcp__metro_box_')) return undefined;
  const legacy = entries.filter((gate) => !isOrgRelayId(gate.id) && toolName.startsWith(`mcp__${normalized(`metro.box ${gate.name}`)}__`));
  const gate = legacy.length === 1 ? legacy[0] : undefined;
  if (gate === undefined) return undefined;
  const called = toolName.slice(`mcp__${normalized(`metro.box ${gate.name}`)}__`.length);
  return called === '' ? undefined : resolvedTool(gate, called);
}
