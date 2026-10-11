import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Col } from '@stage-labs/kit/react-native/box';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { connectorHost, type NewConnector } from '@metro-labs/client/api/connectors';
import { addOrgConnector, orgConnectorCallbackUrl, type OrgConnector, type OrgConnectors as OrgList } from '@metro-labs/client/api/org-connectors';
import { routeHash } from '@metro-labs/client/route';
import { Frame } from './Shell.js';
import { PlainSidebar } from './PlainSidebar.js';
import { ListHeader } from './ListHeader.js';
import { ListRow, LIST_ICON_SIZE } from './ListRow.js';
import { ConnectorFavicon } from './ConnectorFavicon.js';
import { ConnectorModal, type AddedConnector } from './AddConnector.js';
import { EmptyCard, SettingsGroup } from './SettingsSection.js';
import { Loading } from './Loading.js';
import { Tag } from './Tag.js';
import { OrgConnectorActivity } from './OrgConnectorActivity.js';
import { orgConnectorStatus } from './org-connector-status.js';
import { queryError } from '../lib/queries.js';
import { refreshOrgConnectors, useConnectorScope, useOrgConnectorsQuery } from '../lib/org-connector-queries.js';
import { useDocumentTitle } from '../lib/title.js';
import { logError } from '../lib/log.js';
import { go } from '../lib/nav.js';

const NOTE = 'Connectors your organization shares with its agents. Give each one only to the agents that need it. Agents start using them in a coming Metro update. Until then, each agent keeps its own connectors.';
const MEMBER_NOTE = 'Only an admin of the organization can add or change connectors.';
const EMPTY = 'No organization connector yet. A connector gives agents tools, like a calendar, Notion or GitHub.';
const HINT = 'Metro checks the server from api.metro.box, so it must be a public https address. Leave the header empty for a server you sign in to.';

const agentsLabel = (count: number): string => (count === 1 ? '1 agent' : `${String(count)} agents`);

function ConnectorRow({ connector }: { connector: OrgConnector }): ReactNode {
  const status = orgConnectorStatus(connector);
  return (
    <ListRow
      title={connector.name}
      detail={`${connectorHost(connector.url)} · ${status.text}`}
      href={routeHash({ kind: 'org-connector', id: connector.id })}
      icon={<ConnectorFavicon name={connector.name} url={connector.url} size={LIST_ICON_SIZE} />}
      muted={status.bad}
      extra={connector.readOnly ? <Tag label="Read-only" /> : undefined}
      trailing={<Text size="2xs" role="secondary">{agentsLabel(connector.agents.length)}</Text>}
    />
  );
}

function ConnectorList({ list }: { list: OrgList }): ReactNode {
  if (list.connectors.length === 0) return <EmptyCard text={EMPTY} />;
  return (
    <SettingsGroup>
      {list.connectors.map((connector) => (
        <ConnectorRow key={connector.id} connector={connector} />
      ))}
    </SettingsGroup>
  );
}

const createInOrganization = async (values: NewConnector): Promise<AddedConnector> => {
  const result = await addOrgConnector(values);
  return { id: result.connector.id, authorizeUrl: result.kind === 'oauth' ? result.authorizeUrl : null };
};

function AddButton({ onAdded }: { onAdded: (id: string) => void }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [adding, setAdding] = useState(false);
  return (
    <>
      <Button color="primary" dark={dark} label="Add connector" onPress={() => { setAdding(true); }} />
      <ConnectorModal
        title="Add connector"
        hint={HINT}
        callbackUrl={orgConnectorCallbackUrl()}
        create={createInOrganization}
        open={adding}
        onClose={() => { setAdding(false); }}
        onAdded={onAdded}
      />
    </>
  );
}

function ListState({ list, error }: { list: OrgList | undefined; error: Error | null }): ReactNode {
  if (error !== null) return <Text size="2xs" role="danger">{queryError(error, 'Could not load the connectors.')}</Text>;
  return list === undefined ? <Loading /> : <ConnectorList list={list} />;
}

function Body(): ReactNode {
  const client = useQueryClient();
  const { data, error } = useOrgConnectorsQuery();
  const admin = data?.admin ?? false;
  const added = (id: string): void => {
    refreshOrgConnectors(client).catch(logError('org-connectors'));
    go({ kind: 'org-connector', id });
  };
  return (
    <Col gap={20} width="100%">
      <ListHeader title="Connectors" count={data?.connectors.length} action={admin ? <AddButton onAdded={added} /> : undefined} />
      <Text size="2xs" role="secondary">{data === undefined || admin ? NOTE : `${NOTE} ${MEMBER_NOTE}`}</Text>
      <ListState list={data} error={error} />
      {admin ? <OrgConnectorActivity connector={null} /> : null}
    </Col>
  );
}

export function OrgConnectors({ onLock }: { onLock: () => void }): ReactNode {
  const scope = useConnectorScope();
  useDocumentTitle('Connectors');
  return (
    <Frame sidebar={(closeMenu) => <PlainSidebar selection={{ kind: 'org-connectors' }} onSelect={closeMenu} />} onLock={onLock}>
      <Body key={scope} />
    </Frame>
  );
}
