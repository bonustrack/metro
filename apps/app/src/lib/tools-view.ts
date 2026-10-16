import type { OrgConnector } from '@metro-labs/client/api/org-connectors';
import { groupAccess, stricterAccess, type Access, type ToolGroup } from '@metro-labs/client/api/policy';
import type { Vault } from '@metro-labs/client/api/vault';

export const RULE_WORD: Record<Access, string> = { allow: 'Allowed', ask: 'Asks first', deny: 'Not allowed' };

export interface RulePart {
  label: string;
  access: Access;
}

export interface ConnectorRule {
  signedOut: boolean;
  parts: RulePart[];
  exceptions: number;
}

const GROUPS: readonly [ToolGroup, string][] = [
  ['read', 'Read'],
  ['write', 'Change'],
];

export function connectorRule(connector: OrgConnector, agentId: string | undefined): ConnectorRule {
  const own = connector.agents.find((agent) => agent.id === agentId)?.policy ?? {};
  const parts = GROUPS.map(([group, label]) => ({ label, access: stricterAccess(groupAccess(connector.policy, group), groupAccess(own, group)) }));
  const exceptions = new Set([...Object.keys(connector.policy.tools ?? {}), ...Object.keys(own.tools ?? {})]).size;
  return { signedOut: connector.auth === 'oauth' && connector.signIn !== 'connected', parts, exceptions };
}

export const exceptionsLabel = (count: number): string => (count === 1 ? '1 exception' : `${String(count)} exceptions`);

export function keyLastUsed(vault: Vault, id: string): string | null {
  let latest: string | null = null;
  for (const request of vault.recent) if (request.swapped.includes(id) && (latest === null || request.at > latest)) latest = request.at;
  return latest;
}
