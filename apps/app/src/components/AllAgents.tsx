import { type ReactNode, useEffect, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { namedSegment } from '@metro-labs/client/auth/org-segment';
import { type DashboardState } from '@metro-labs/client/api/dashboard';
import { useAllAgents } from '../lib/all-agents.js';
import { useIsNarrow } from '../lib/media.js';
import { useDocumentTitle } from '../lib/title.js';
import { AllAgentRow } from './AllAgentRow.js';
import { ListHeader } from './ListHeader.js';
import { PlainSidebar } from './PlainSidebar.js';
import { RouteLink } from './RouteLink.js';
import { Frame } from './Shell.js';

function Columns(): ReactNode {
  return (
    <Row gap={24} align="start">
      <Col flex={2} minWidth={0}><Text size="2xs" role="secondary">Organization / Agent</Text></Col>
      <Col flex={2} minWidth={0}><Text size="2xs" role="secondary">Status</Text></Col>
      <Col flex={3} minWidth={0}><Text size="2xs" role="secondary">Model usage</Text></Col>
      <Col flex={1} minWidth={0}><Text size="2xs" role="secondary">Harness</Text></Col>
    </Row>
  );
}

function InventoryMessages({ state }: { state: DashboardState }): ReactNode {
  const { organizations, loading, error, refreshing } = state;
  return (
    <>
      {refreshing && !loading ? <Text size="2xs" role="secondary">Refreshing…</Text> : null}
      {error === null ? null : <Text size="sm" role="danger">{organizations === null ? 'Could not load agents.' : 'Could not refresh agents.'} {error}</Text>}
      {loading && organizations === null ? <Text size="sm" role="secondary">Loading agents…</Text> : null}
      {organizations?.length === 0 ? <Text size="sm" role="secondary">No organizations yet.</Text> : null}
    </>
  );
}

export function AllAgents({ onLock }: { onLock: () => void }): ReactNode {
  const state = useAllAgents();
  const { organizations, rows } = state;
  const narrow = useIsNarrow();
  const [, tick] = useState(0);
  const now = Date.now();
  useDocumentTitle('All agents');
  useEffect(() => {
    const timer = setInterval(() => { tick((value) => value + 1); }, 15_000);
    return () => { clearInterval(timer); };
  }, []);
  const withoutAgents = organizations?.filter((organization) => organization.agents == null || organization.agents.length === 0) ?? [];
  return (
    <Frame sidebar={(close) => <PlainSidebar selection={{ kind: 'all-agents' }} onSelect={close} />} onLock={onLock}>
      <Col gap={20} width="100%">
        <ListHeader title="All agents" />
        <Col gap={16} width="100%" maxWidth={1120}>
          <Text size="sm" role="secondary">Across all your organizations.</Text>
          <InventoryMessages state={state} />
          {rows.length > 0 ? (
            <Col gap={8}>
              {narrow ? null : <Columns />}
              {rows.map((row) => <AllAgentRow key={row.key} row={row} now={now} narrow={narrow} />)}
            </Col>
          ) : null}
          {withoutAgents.map((organization) => (
            <Col key={organization.id} gap={4} padding={{ y: 12 }}>
              <RouteLink to={`#/${namedSegment(organization.id, organization.slug)}`}>
                <Text size="sm" role="link">{organization.name ?? organization.slug ?? organization.id}</Text>
              </RouteLink>
              <Text size="sm" role="secondary">{organization.agents == null ? 'Agent inventory unavailable.' : 'No agents in this organization.'}</Text>
            </Col>
          ))}
        </Col>
      </Col>
    </Frame>
  );
}
