import type { ToolGroup } from '@metro-labs/core/stations/types';
import { policyFor, setPolicies, type PolicyTarget, type ToolPolicy } from '../policy/policy.js';
import { serverKeysOf } from './plugin-sync.js';
import { takeGrant } from '../approvals/pending.js';
import { NEEDS_APPROVAL } from '../approvals/needs.js';

interface GateRow {
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

export function registerConnectors(rows: readonly GateRow[]): void {
  const keys = serverKeysOf([...rows]);
  gates = rows.map((row) => ({
    id: row.id,
    name: row.name,
    server: keys.get(row.id) ?? '',
    policy: row.config.policy ?? {},
    tools: row.config.toolGroups ?? {},
  }));
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
  if (gate === undefined) return null;
  const access = policyFor({ kind: 'connector', id: connectorId }, { name: tool, group: toolGroupOf(gate, tool) });
  if (access === 'deny') return `Blocked by the owner's policy for ${gate.name} (${tool}).`;
  if (access === 'allow' || takeGrant(promptFor(connectorId, tool), args)) return null;
  return NEEDS_APPROVAL(gate.name, tool);
}

function prefixesOf(gate: ConnectorGate): string[] {
  return [`mcp__plugin_metro_${gate.server}__`, `mcp__${gate.server}__`, `mcp__${normalized(`metro.box ${gate.name}`)}__`];
}

export function connectorToolOf(toolName: string): { gate: ConnectorGate; tool: string } | undefined {
  if (toolName.startsWith('mcp__metro__')) return undefined;
  for (const gate of gates)
    for (const prefix of prefixesOf(gate))
      if (toolName.startsWith(prefix) && toolName.length > prefix.length) {
        const called = toolName.slice(prefix.length);
        const known = [...Object.keys(gate.tools), ...Object.keys(gate.policy.tools ?? {})];
        return { gate, tool: known.find((name) => name === called) ?? known.find((name) => normalized(name) === called) ?? called };
      }
  return undefined;
}
