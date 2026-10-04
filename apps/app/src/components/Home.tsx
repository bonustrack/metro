import { type ReactNode } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { CountBadge } from './CountBadge.js';
import { PageTitle } from './PageTitle.js';
import { Loading } from './Loading.js';
import { MetroVersion } from './MetroVersion.js';
import { AgentPicture, ChannelCards, ConnectorIcons, StatusLine } from './AgentOverview.js';
import { Checklist } from './Checklist.js';
import { AgentRoute } from './AgentModel.js';
import { Approvals } from './Approvals.js';
import { LatestUsageLine } from './LatestUsage.js';
import { flattenAccounts, type AccountGroup } from '@metro-labs/client/api/accounts';
import { queryError, useConnectorsQuery, useServersQuery, useStationsQuery } from '../lib/queries.js';
import { currentServer } from '@metro-labs/client/auth/daemon';
import { serverLabel } from '@metro-labs/client/api/servers';
import { type AgentSummary } from '@metro-labs/client/api/client';
import { useDocumentTitle } from '../lib/title.js';

const FALLBACK = 'Could not read this machine.';

function SectionHead({ label, count }: { label: string; count: number }): ReactNode {
  return (
    <Row gap={8} align="center">
      <Text size="md" weight="semibold">{label}</Text>
      <CountBadge count={count} />
    </Row>
  );
}

function NoAgent(): ReactNode {
  return (
    <Col gap={16}>
      <PageTitle>This box</PageTitle>
      <Text size="2xs" role="secondary">
        Setting up this box… the daemon creates its agent at start, this fills in within seconds.
      </Text>
    </Col>
  );
}

function useBoxName(agent: AgentSummary | undefined): string {
  const servers = useServersQuery();
  const here = currentServer();
  const server = servers.data?.find((s) => s.id === here?.id);
  if (server !== undefined) return serverLabel(server);
  return agent === undefined || agent.name === '' ? 'This box' : agent.name;
}

interface SectionsProps {
  agent: AgentSummary;
  groups: AccountGroup[];
  project: string;
}

function Sections({ agent, groups, project }: SectionsProps): ReactNode {
  const connectors = useConnectorsQuery();
  const channels = flattenAccounts(groups).length;
  return (
    <>
      {channels === 0 ? null : (
        <Col gap={8}>
          <SectionHead label="Channels" count={channels} />
          <ChannelCards groups={groups} project={project} />
        </Col>
      )}
      {agent.connectorIds.length === 0 ? null : (
        <Col gap={12}>
          <SectionHead label="Connectors" count={agent.connectorIds.length} />
          {connectors.data === undefined ? null : <ConnectorIcons connectors={connectors.data.connectors} project={project} />}
        </Col>
      )}
    </>
  );
}

export function Home({ project }: { project: string }): ReactNode {
  const { data, error } = useStationsQuery();
  const servers = useServersQuery();
  const here = currentServer();
  const server = servers.data?.find((s) => s.id === here?.id);
  const agent = data?.agent;
  const name = useBoxName(agent);
  useDocumentTitle(name);
  if (error !== null) return <Text size="2xs" role="danger">{queryError(error, FALLBACK)}</Text>;
  if (data === undefined) return <Loading />;
  if (agent === undefined) return <NoAgent />;
  return (
    <Col gap={32}>
      <Col gap={16}>
        <Row align="center" gap={16}>
          <AgentPicture server={server} seed={agent.id} />
          <Col gap={6} flex={1} minWidth={0}>
            <PageTitle>{name}</PageTitle>
            <StatusLine host={here?.host ?? null} project={project} />
            {server === undefined ? null : <LatestUsageLine serverId={server.id} />}
          </Col>
        </Row>
        <MetroVersion quiet />
      </Col>
      <Checklist
        name={name}
        project={project}
        channels={flattenAccounts(data.groups).length}
        connectors={agent.connectorIds.length}
      />
      <Approvals />
      <AgentRoute project={project} />
      <Sections agent={agent} groups={data.groups} project={project} />
    </Col>
  );
}
