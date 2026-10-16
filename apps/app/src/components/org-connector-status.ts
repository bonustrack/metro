import type { OrgConnector } from '@metro-labs/client/api/org-connectors';

export function orgConnectorStatus(connector: OrgConnector): { text: string; bad: boolean } {
  if (connector.auth === 'oauth') return connector.signIn === 'connected' ? { text: 'Signed in', bad: false } : { text: 'Signed out', bad: true };
  return connector.auth === 'header' ? { text: 'Key saved', bad: false } : { text: 'No sign-in needed', bad: false };
}

export function connectorLine(connector: OrgConnector): string {
  const status = orgConnectorStatus(connector);
  if (status.bad) return status.text;
  const count = connector.agents.length;
  const agents = count === 0 ? 'No agent yet' : `${String(count)} ${count === 1 ? 'agent' : 'agents'}`;
  return `${status.text} · ${agents}`;
}
