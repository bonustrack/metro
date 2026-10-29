import { type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Column } from '@stage-labs/kit/react-native/column';
import { Row } from '@stage-labs/kit/react-native/row';
import { Tabs } from '@stage-labs/kit/react-native/tabs';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { connectorHost } from '@metro-labs/client/api/connectors';
import { renameOrgConnector, type OrgConnector } from '@metro-labs/client/api/org-connectors';
import { ConnectorFavicon } from '../ConnectorFavicon.js';
import { orgConnectorStatus } from '../org-connector-status.js';
import { EditableTitle } from '../ui/EditableTitle.js';
import { PageHeader } from '../ui/PageHeader.js';
import { side } from '../ui/edges.js';
import { AVATAR_SIZE } from '../ui/sizes.js';
import { go } from '../../lib/nav.js';
import { refreshOrgConnectors, useOrgConnectorToolsQuery } from '../../lib/org-connector-queries.js';
import { useTechnicalDetails } from '../../lib/technical.js';
import { optionTabs } from '../../lib/option-tabs.js';

export type ConnectorTabId = 'tools' | 'agents' | 'settings';

const TABS: { value: ConnectorTabId; label: string }[] = [
  { value: 'tools', label: 'Tools' },
  { value: 'agents', label: 'Agents' },
  { value: 'settings', label: 'Settings' },
];

function Subtitle({ connector }: { connector: OrgConnector }): ReactNode {
  const technical = useTechnicalDetails();
  const tools = useOrgConnectorToolsQuery(connector.id).data;
  const status = orgConnectorStatus(connector);
  const tone = status.bad ? 'danger' : connector.auth === 'oauth' ? 'success' : 'secondary';
  const rest = [tools === undefined ? null : `${String(tools.length)} ${tools.length === 1 ? 'tool' : 'tools'}`, technical ? connectorHost(connector.url) : null].filter((part) => part !== null);
  return (
    <Text size="xs" color="secondary" numberOfLines={2}>
      <Text size="xs" color={tone}>{status.text}</Text>
      {rest.map((part) => ` · ${part}`).join('')}
    </Text>
  );
}

function ConnectorTabs({ connector, tab }: { connector: OrgConnector; tab: ConnectorTabId }): ReactNode {
  const palette = useKitPalette();
  return (
    <Column border={{ bottom: side(palette.border) }}>
      <Row>
        <Tabs
          variant="underline"
          {...optionTabs(TABS, tab, (next) => {
            go({ kind: 'org-connector', id: connector.id, ...(next === 'tools' ? {} : { tab: next }) });
          })}
        />
      </Row>
    </Column>
  );
}

export function ConnectorHeader({ connector, tab, action, admin }: { connector: OrgConnector; tab: ConnectorTabId; action?: ReactNode; admin: boolean }): ReactNode {
  const client = useQueryClient();
  const rename = async (name: string): Promise<void> => {
    await renameOrgConnector(connector.id, name);
    await refreshOrgConnectors(client);
  };
  return (
    <PageHeader
      title={<EditableTitle value={connector.name} label={`Rename ${connector.name}`} {...(admin ? { onRename: rename } : {})} />}
      subtitle={<Subtitle connector={connector} />}
      leading={<ConnectorFavicon name={connector.name} url={connector.url} size={AVATAR_SIZE.header} />}
      action={action}
      tabs={<ConnectorTabs connector={connector} tab={tab} />}
    />
  );
}
