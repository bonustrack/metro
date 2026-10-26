import { type ReactNode } from 'react';
import { Column } from '@stage-labs/kit/react-native/column';
import { Row } from '@stage-labs/kit/react-native/row';
import { Button } from '@stage-labs/kit/react-native/button';
import { Tabs } from '@stage-labs/kit/react-native/tabs';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { connectorHost } from '@metro-labs/client/api/connectors';
import type { OrgConnector } from '@metro-labs/client/api/org-connectors';
import { whenLabel } from '@metro-labs/client/api/when';
import { ConnectorFavicon } from '../ConnectorFavicon.js';
import { Icon } from '../Icon.js';
import { orgConnectorStatus } from '../org-connector-status.js';
import { PageHeader } from '../ui/PageHeader.js';
import { RoundButton } from '../ui/RoundButton.js';
import { side } from '../ui/edges.js';
import { AVATAR_SIZE, ICON_SIZE } from '../ui/sizes.js';
import { logError } from '../../lib/log.js';
import { useIsNarrow } from '../../lib/media.js';
import { go } from '../../lib/nav.js';
import { useOrgConnectorToolsQuery } from '../../lib/org-connector-queries.js';
import { useTechnicalDetails } from '../../lib/technical.js';
import { useNow } from '../../lib/use-now.js';
import { optionTabs } from '../../lib/option-tabs.js';

export type ConnectorTabId = 'tools' | 'agents' | 'settings';

const TABS: { value: ConnectorTabId; label: string }[] = [
  { value: 'tools', label: 'Tools' },
  { value: 'agents', label: 'Agents' },
  { value: 'settings', label: 'Settings' },
];

const CLOCK_MS = 30_000;

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

export function RefreshTools({ connector }: { connector: OrgConnector }): ReactNode {
  const palette = useKitPalette();
  const narrow = useIsNarrow();
  const now = useNow(CLOCK_MS);
  const tools = useOrgConnectorToolsQuery(connector.id);
  const refresh = (): void => { tools.refetch().catch(logError('org-connector-tools')); };
  if (narrow) return <RoundButton label="Refresh tools" icon="refresh" disabled={tools.isFetching} onPress={refresh} />;
  const read = tools.dataUpdatedAt > 0 ? `Last read ${whenLabel(new Date(tools.dataUpdatedAt).toISOString(), now)}` : null;
  return (
    <>
      {read === null ? null : <Text size="xs" color="secondary">{read}</Text>}
      <Button color="secondary" label="Refresh tools" loading={tools.isFetching} disabled={tools.isFetching} iconStart={<Icon name="refresh" size={ICON_SIZE.sm} color={palette.link} />} onPress={refresh} />
    </>
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

export function ConnectorHeader({ connector, tab, action }: { connector: OrgConnector; tab: ConnectorTabId; action?: ReactNode }): ReactNode {
  return (
    <PageHeader
      title={connector.name}
      subtitle={<Subtitle connector={connector} />}
      leading={<ConnectorFavicon name={connector.name} url={connector.url} size={AVATAR_SIZE.header} />}
      action={action}
      tabs={<ConnectorTabs connector={connector} tab={tab} />}
    />
  );
}
