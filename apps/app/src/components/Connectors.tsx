import { type ReactNode } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { currentServer } from '@metro-labs/client/auth/daemon';
import { routeHash } from '@metro-labs/client/route';
import type { OrgConnector } from '@metro-labs/client/api/org-connectors';
import { EmptyCard } from './SettingsSection.js';
import { ListHeader } from './ListHeader.js';
import { Loading } from './Loading.js';
import { TextLink } from './TextLink.js';
import { AgentOrgConnectors, useAssignedConnectors } from './AgentOrgConnectors.js';
import { queryError } from '../lib/queries.js';
import { useConnectorScope } from '../lib/org-connector-queries.js';
import { useDocumentTitle } from '../lib/title.js';

const EMPTY = 'No connector is assigned to this agent yet. A connector gives it tools, like a calendar, Notion or GitHub.';

function Assigned({ connectors, admin }: { connectors: OrgConnector[]; admin: boolean }): ReactNode {
  return (
    <>
      {connectors.length === 0 ? <EmptyCard text={EMPTY} /> : <AgentOrgConnectors assigned={connectors} admin={admin} />}
      <TextLink to={routeHash({ kind: 'org-connectors' })}>Add or assign connectors on the organization’s Connectors page</TextLink>
    </>
  );
}

function Body(): ReactNode {
  const { connectors, admin, error } = useAssignedConnectors();
  return (
    <Col gap={16}>
      <ListHeader title="Connectors" count={connectors?.length} />
      {error === null ? null : <Text size="md" role="danger">{queryError(error, 'Could not load the organization’s connectors.')}</Text>}
      {connectors === undefined && error === null ? <Loading /> : null}
      {connectors === undefined ? null : <Assigned connectors={connectors} admin={admin} />}
    </Col>
  );
}

export function Connectors(): ReactNode {
  const scope = useConnectorScope();
  useDocumentTitle('Connectors');
  return <Body key={`${String(scope)}:${currentServer()?.id ?? ''}`} />;
}
