import { type ReactNode } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Text } from './ui.js';
import { CountBadge } from './CountBadge.js';
import { PageTitle } from './PageTitle.js';
import { Loading } from './Loading.js';
import { MetroVersion } from './MetroVersion.js';
import { AgentPicture, ChannelCards, ConnectorIcons, StatusPills } from './AgentOverview.js';
import { AgentRoute } from './AgentModel.js';
import { accountsForAgent, stationCount, type AccountGroup } from '../api/accounts.js';
import { queryError, useConnectorsQuery, useModeQuery, useServersQuery, useStationsQuery } from '../api/queries.js';
import { currentServer } from '../auth/daemon.js';
import { serverLabel } from '../api/servers.js';
import { olderThan } from '../api/version.js';
import { type AgentSummary } from '../api/client.js';
import { type Selection } from './selection.js';
import { useDocumentTitle } from '../title.js';

const FALLBACK = 'Could not read this machine.';

function SectionHead({ label, count }: { label: string; count: number }): ReactNode {
  return (
    <Row gap={8} align="center">
      <Text size="md" weight="semibold">{label}</Text>
      <CountBadge count={count} />
    </Row>
  );
}

const AGENT_SINCE = '0.1.0-beta.132';

function NoAgent(): ReactNode {
  const mode = useModeQuery();
  const old = olderThan(mode.data?.version ?? null, AGENT_SINCE);
  return (
    <Col gap={16}>
      <PageTitle>This box</PageTitle>
      <Text size="sm" role="secondary">
        {old
          ? `This box has no agent yet. Since metro ${AGENT_SINCE} the daemon creates it at start; update metro on this box from the Server page, and it appears here.`
          : 'Setting up this box… the daemon creates its agent at start, this fills in within seconds.'}
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
  onSelect: (selection: Selection) => void;
}

function Sections({ agent, groups, project, onSelect }: SectionsProps): ReactNode {
  const connectors = useConnectorsQuery();
  const channels = stationCount(groups, agent.id);
  return (
    <>
      {channels === 0 ? null : (
        <Col gap={8}>
          <SectionHead label="Channels" count={channels} />
          <ChannelCards groups={accountsForAgent(groups, agent.id)} project={project} onSelect={onSelect} />
        </Col>
      )}
      {agent.connectorIds.length === 0 ? null : (
        <Col gap={12}>
          <SectionHead label="Connectors" count={agent.connectorIds.length} />
          <ConnectorIcons connectors={connectors.data?.connectors ?? []} project={project} onSelect={onSelect} />
        </Col>
      )}
    </>
  );
}

interface HomeProps {
  project: string;
  onSelect: (selection: Selection) => void;
}

export function Home({ project, onSelect }: HomeProps): ReactNode {
  const { data, error } = useStationsQuery();
  const servers = useServersQuery();
  const here = currentServer();
  const server = servers.data?.find((s) => s.id === here?.id);
  const agent = data?.agents[0];
  const name = useBoxName(agent);
  useDocumentTitle(name);
  if (error !== null) return <Text size="sm" role="danger">{queryError(error, FALLBACK)}</Text>;
  if (data === undefined) return <Loading />;
  if (agent === undefined) return <NoAgent />;
  return (
    <Col gap={32}>
      <Col gap={16}>
        <Row align="center" gap={16}>
          <AgentPicture server={server} seed={agent.id} />
          <Col gap={6} flex={1} minWidth={0}>
            <PageTitle>{name}</PageTitle>
            <StatusPills host={here?.host ?? null} project={project} onSelect={onSelect} />
          </Col>
        </Row>
        <MetroVersion />
      </Col>
      <AgentRoute project={project} onSelect={onSelect} />
      <Sections agent={agent} groups={data.groups} project={project} onSelect={onSelect} />
    </Col>
  );
}
