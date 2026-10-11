import type { OrgConnector } from '@metro-labs/client/api/org-connectors';

export function orgConnectorStatus(connector: OrgConnector): { text: string; bad: boolean } {
  if (connector.auth === 'oauth') return connector.signIn === 'connected' ? { text: 'Signed in', bad: false } : { text: 'Needs sign-in', bad: true };
  return connector.auth === 'header' ? { text: 'Key in a header', bad: false } : { text: 'No sign-in needed', bad: false };
}
