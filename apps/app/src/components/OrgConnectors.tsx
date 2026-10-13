import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Col } from '@stage-labs/kit/react-native/box';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { connectorHost, connectorLabel } from '@metro-labs/client/api/connectors';
import { addOrgConnector, orgConnectorCallbackUrl, type NewOrgConnector, type OrgConnector, type OrgConnectors as OrgList } from '@metro-labs/client/api/org-connectors';
import { routeHash } from '@metro-labs/client/route';
import { Frame } from './Shell.js';
import { PlainSidebar } from './PlainSidebar.js';
import { ListHeader } from './ListHeader.js';
import { ListRow, LIST_ICON_SIZE } from './ListRow.js';
import { ConnectorFavicon } from './ConnectorFavicon.js';
import { ConnectorModal, type AddedConnector } from './AddConnector.js';
import { EmptyCard } from './SettingsSection.js';
import { Loading } from './Loading.js';
import { Tag } from './Tag.js';
import { AgentStack } from './AgentStack.js';
import { orgConnectorStatus } from './org-connector-status.js';
import { queryError } from '../lib/queries.js';
import { refreshOrgConnectors, useConnectorScope, useOrgConnectorsQuery } from '../lib/org-connector-queries.js';
import { useDocumentTitle } from '../lib/title.js';
import { logError } from '../lib/log.js';
import { go } from '../lib/nav.js';

const MEMBER_NOTE = 'Only an admin of the organization can add or change connectors.';
const EMPTY = 'No organization connector yet. A connector gives agents tools, like a calendar, Notion or GitHub.';
const HINT = 'Metro checks the server from api.metro.box, so it must be a public https address. Leave the header empty for a server you sign in to.';

function ConnectorRow({ connector, label }: { connector: OrgConnector; label: string }): ReactNode {
  const status = orgConnectorStatus(connector);
  const detail = `${connectorHost(connector.url)} · ${status.text}`;
  return (
    <ListRow
      title={connector.name}
      label={label}
      detail={label === connector.name ? detail : `${connector.id} · ${detail}`}
      href={routeHash({ kind: 'org-connector', id: connector.id })}
      icon={<ConnectorFavicon name={connector.name} url={connector.url} size={LIST_ICON_SIZE} />}
      muted={status.bad}
      highlight={false}
      extra={connector.readOnly ? <Tag label="Read-only" /> : undefined}
      trailing={connector.agents.length === 0 ? <Text size="2xs" role="secondary">No agent</Text> : <AgentStack ids={connector.agents.map((a) => a.id)} />}
    />
  );
}

function ConnectorList({ list }: { list: OrgList }): ReactNode {
  if (list.connectors.length === 0) return <EmptyCard text={EMPTY} />;
  return (
    <Col>
      {list.connectors.map((connector) => (
        <ConnectorRow key={connector.id} connector={connector} label={connectorLabel(connector, list.connectors)} />
      ))}
    </Col>
  );
}

const createInOrganization = async (values: NewOrgConnector): Promise<AddedConnector> => {
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
        allowPublicOAuthResource
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
      <ListHeader title="Connectors" rule={false} count={data?.connectors.length} action={data === undefined || admin ? <AddButton onAdded={added} /> : undefined} />
      {data === undefined || admin ? null : <Text size="2xs" role="secondary">{MEMBER_NOTE}</Text>}
      <ListState list={data} error={error} />
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
