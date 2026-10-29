import { type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { deleteOrgConnector, type OrgConnector } from '@metro-labs/client/api/org-connectors';
import { ConfirmDialog, useConfirm } from '../DeleteMenu.js';
import { type MenuItem } from '../Dropdown.js';
import { KebabMenu } from '../KebabMenu.js';
import { logError } from '../../lib/log.js';
import { go } from '../../lib/nav.js';
import { refreshOrgConnectors, useOrgConnectorToolsQuery } from '../../lib/org-connector-queries.js';

export function ConnectorMenu({ connector, admin }: { connector: OrgConnector; admin: boolean }): ReactNode {
  const client = useQueryClient();
  const tools = useOrgConnectorToolsQuery(connector.id);
  const removing = useConfirm(async () => {
    await deleteOrgConnector(connector.id);
    await refreshOrgConnectors(client);
  }, 'Could not remove the connector.', () => { go({ kind: 'org-connectors' }); });
  const items: MenuItem[] = [
    { label: 'Refresh tools list', onSelect: () => { tools.refetch().catch(logError('org-connector-tools')); } },
    ...(admin ? [{ label: 'Remove', danger: true, onSelect: removing.show }] : []),
  ];
  return (
    <>
      <KebabMenu items={items} label={`More for ${connector.name}`} />
      <ConfirmDialog confirming={removing} title={`Remove ${connector.name}?`} lines={[`${connector.name} and its sign-in are removed, and every agent loses its tools at once.`]} action="Remove connector" name={connector.name} />
    </>
  );
}
