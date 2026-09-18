import { type ReactNode } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Text } from './ui.js';
import { PageTitle } from './PageTitle.js';
import { Loading } from './Loading.js';
import { MetroVersion } from './MetroVersion.js';
import { AgentPicture, ChannelCards, ConnectorIcons, StatusPills } from './AgentOverview.js';
import { AgentRoute, AgentUsage } from './AgentModel.js';
import { accountsForAgent, stationCount } from '../api/accounts.js';
import { queryError, useConnectorsQuery, useModeQuery, useServersQuery, useStationsQuery } from '../api/queries.js';
import { currentServer } from '../auth/daemon.js';
import { serverLabel } from '../api/servers.js';
import { olderThan } from '../api/version.js';
import { type AgentSummary } from '../api/client.js';
import { routeHash } from '../route.js';
import { opensElsewhere } from './link.js';
import { type Selection } from './selection.js';
import { useDocumentTitle } from '../title.js';

const FALLBACK = 'Could not read this machine.';

function Summary({
  label,
  count,
  target,
  onSelect,
}: {
  label: string;
  count: number;
  target: Selection;
  onSelect: (s: Selection) => void;
}): ReactNode {
  return (
    <a
      className="row-link"
      href={routeHash(target)}
      onClick={(e) => {
        if (opensElsewhere(e)) return;
        e.preventDefault();
        onSelect(target);
      }}
    >
      <Row gap={10} align="center" padding={{ y: 4 }}>
        <Text size="md" weight="semibold">
          {label}
        </Text>
        <Text size="sm" role="secondary">
          {String(count)}
        </Text>
      </Row>
    </a>
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

interface HomeProps {
  project: string;
  onSelect: (selection: Selection) => void;
}

export function Home({ project, onSelect }: HomeProps): ReactNode {
  const { data, error } = useStationsQuery();
  const connectors = useConnectorsQuery();
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
    <Col gap={24}>
      <div className="agent-top">
        <Col gap={20}>
          <Col gap={12}>
            <Row align="center" gap={16}>
              <AgentPicture server={server} seed={agent.id} />
              <Col gap={4} flex={1} minWidth={0}>
                <PageTitle>{name}</PageTitle>
                <Text size="sm" role="secondary" numberOfLines={1}>
                  id {agent.id}
                </Text>
              </Col>
            </Row>
            <StatusPills host={here?.host ?? null} project={project} onSelect={onSelect} />
            <MetroVersion />
          </Col>
          <AgentRoute project={project} onSelect={onSelect} />
        </Col>
        <AgentUsage />
      </div>
      <Col gap={10}>
        <Summary label="Channels" count={stationCount(data.groups, agent.id)} target={{ kind: 'stations', project }} onSelect={onSelect} />
        <ChannelCards groups={accountsForAgent(data.groups, agent.id)} project={project} onSelect={onSelect} />
      </Col>
      <Col gap={10}>
        <Summary label="Connectors" count={agent.connectorIds.length} target={{ kind: 'connectors', project }} onSelect={onSelect} />
        <ConnectorIcons connectors={connectors.data?.connectors ?? []} project={project} onSelect={onSelect} />
      </Col>
    </Col>
  );
}
