import { type ReactNode } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { connectorHost, connectorLabel } from '@metro-labs/client/api/connectors';
import type { OrgConnector, OrgConnectors as OrgList } from '@metro-labs/client/api/org-connectors';
import { routeHash } from '@metro-labs/client/route';
import { ConnectorFavicon } from './ConnectorFavicon.js';
import { ErrorState } from './ui/ErrorState.js';
import { RoundButton } from './ui/RoundButton.js';
import { RowsSkeleton } from './ui/RowsSkeleton.js';
import { connectorLine, orgConnectorStatus } from './org-connector-status.js';
import { Rows } from './ui/Group.js';
import { Item } from './ui/Item.js';
import { ListPaneRow } from './ui/ListPaneRow.js';
import { StateBlock } from './ui/StateBlock.js';
import { ListPane } from './shell/ListPane.js';
import { TabRoot } from './shell/TabRoot.js';
import { technicalLine } from '../lib/agent-line.js';
import { queryError } from '../lib/queries.js';
import { useConnectorScope, useOrgConnectorsQuery } from '../lib/org-connector-queries.js';
import { useTechnicalDetails } from '../lib/technical.js';
import { useDocumentTitle } from '../lib/title.js';
import { go } from '../lib/nav.js';

const MEMBER_NOTE = 'Only an admin of the organization can add or change connectors.';
const EMPTY = 'Connectors give agents tools, like a calendar, Notion or GitHub.';
const ICON = 32;

function ConnectorRow({ connector, peers, pane, selected }: { connector: OrgConnector; peers: OrgConnector[]; pane: boolean; selected: boolean }): ReactNode {
  const technical = useTechnicalDetails();
  const status = orgConnectorStatus(connector);
  const title = connectorLabel(connector, peers);
  const detail = technical ? technicalLine([connectorHost(connector.url), connector.id]) : undefined;
  const icon = <ConnectorFavicon name={connector.name} url={connector.url} size={ICON} />;
  const href = routeHash({ kind: 'org-connector', id: connector.id });
  const tone = status.bad ? 'danger' : 'secondary';
  if (pane) return <ListPaneRow title={title} line={connectorLine(connector)} lineTone={tone} detail={detail} avatar={icon} selected={selected} href={href} />;
  return <Item title={title} subtitle={connectorLine(connector)} subtitleTone={tone} detail={detail} leading={icon} href={href} />;
}

function List({ list, pane, selected }: { list: OrgList; pane: boolean; selected: string | null }): ReactNode {
  if (list.connectors.length === 0)
    return pane ? (
      <Col padding={{ x: 12, top: 12 }}>
        <Text size="xs" role="secondary">No connector yet.</Text>
      </Col>
    ) : (
      <NoConnectors admin={list.admin} />
    );
  const rows = list.connectors.map((c) => <ConnectorRow key={c.id} connector={c} peers={list.connectors} pane={pane} selected={c.id === selected} />);
  return pane ? <Col>{rows}</Col> : <Rows>{rows}</Rows>;
}

const addConnector = (): void => { go({ kind: 'org-connector-new' }); };

function AddConnector(): ReactNode {
  return <RoundButton label="Add a connector" icon="plus" onPress={addConnector} />;
}

function NoConnectors({ admin }: { admin: boolean }): ReactNode {
  return <StateBlock icon="plug" title="No connector yet" text={EMPTY} action={admin ? { label: 'Add a connector', primary: true, onPress: addConnector } : undefined} />;
}

function Body({ pane, selected }: { pane: boolean; selected: string | null }): ReactNode {
  const { data, error, refetch } = useOrgConnectorsQuery();
  if (error !== null)
    return (
      <Col padding={pane ? { x: 12, top: 12 } : undefined}>
        <ErrorState title="Could not load the connectors" text={queryError(error, 'Metro did not answer.')} onRetry={refetch} />
      </Col>
    );
  if (data === undefined) return <RowsSkeleton rows={3} pane={pane} trailing={false} />;
  return (
    <Col gap={16}>
      <List list={data} pane={pane} selected={selected} />
      {data.admin ? null : (
        <Col padding={pane ? { x: 12 } : undefined}>
          <Text size="xs" role="secondary">{MEMBER_NOTE}</Text>
        </Col>
      )}
    </Col>
  );
}

function useAdmin(): boolean {
  const { data } = useOrgConnectorsQuery();
  return data === undefined || data.admin;
}

export function OrgConnectorList({ pane, selected = null }: { pane: boolean; selected?: string | null }): ReactNode {
  const scope = useConnectorScope();
  const admin = useAdmin();
  if (pane)
    return (
      <ListPane title="Connectors" action={admin ? <AddConnector /> : undefined}>
        <Body key={scope} pane selected={selected} />
      </ListPane>
    );
  return <ConnectorsRoot scope={scope} admin={admin} />;
}

function ConnectorsRoot({ scope, admin }: { scope: number; admin: boolean }): ReactNode {
  useDocumentTitle('Connectors');
  return (
    <TabRoot title="Connectors" action={admin ? <AddConnector /> : undefined}>
      <Body key={scope} pane={false} selected={null} />
    </TabRoot>
  );
}

export function ConnectorsIdle(): ReactNode {
  const { data } = useOrgConnectorsQuery();
  useDocumentTitle('Connectors');
  if (data !== undefined && data.connectors.length === 0) return <NoConnectors admin={data.admin} />;
  return <StateBlock icon="plug" title="Choose a connector" text="Pick one on the left to see who uses it and what agents may do with it." />;
}
