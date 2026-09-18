import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { useQueryClient } from '@tanstack/react-query';
import { Text, Button } from './ui.js';
import { PageTitle } from './PageTitle.js';
import { ResetAgentKey } from './ResetAgentKey.js';
import { ClaimBox } from './ClaimBox.js';
import { ExportAgent } from './ExportAgent.js';
import { ImportAgent } from './ImportAgent.js';
import { Loading } from './Loading.js';
import { resetAgentKey } from '../api/client.js';
import { stationCount } from '../api/accounts.js';
import { queryError, refreshAgents, useModeQuery, useServersQuery, useStationsQuery } from '../api/queries.js';
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
      <Row gap={10} align="center" padding={{ y: 10 }}>
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

function AgentActions({ agent, name }: { agent: AgentSummary; name: string }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const portable = { id: agent.id, name, key: agent.key ?? '' };
  return (
    <>
      <Row gap={8} wrap>
        <Button
          color="primary"
          dark={dark}
          label="Export"
          onPress={() => {
            setExporting(true);
          }}
        />
        <Button
          color="secondary"
          dark={dark}
          label="Import"
          onPress={() => {
            setImporting(true);
          }}
        />
      </Row>
      <ExportAgent
        open={exporting}
        agent={portable}
        onClose={() => {
          setExporting(false);
        }}
      />
      <ImportAgent
        open={importing}
        agent={portable}
        onClose={() => {
          setImporting(false);
        }}
      />
    </>
  );
}

export function Home({ project, onSelect }: HomeProps): ReactNode {
  const client = useQueryClient();
  const { data, error } = useStationsQuery();
  const agent = data?.agents[0];
  const name = useBoxName(agent);
  useDocumentTitle(name);
  if (error !== null) return <Text size="sm" role="danger">{queryError(error, FALLBACK)}</Text>;
  if (data === undefined) return <Loading />;
  if (agent === undefined) return <NoAgent />;
  return (
    <Col gap={20}>
      <Col gap={8}>
        <Row align="center" justify="between" gap={12}>
          <PageTitle>{name}</PageTitle>
          <ResetAgentKey
            agent={agent}
            onReset={async (id) => {
              await resetAgentKey(id);
              refreshAgents(client);
            }}
          />
        </Row>
        <Text size="sm" role="secondary">
          id {agent.id} · runs on this machine, so its messages never pass through Metro&apos;s servers
        </Text>
      </Col>
      <ClaimBox />
      <Col>
        <Summary label="Channels" count={stationCount(data.groups, agent.id)} target={{ kind: 'stations', project }} onSelect={onSelect} />
        <Summary label="Connectors" count={agent.connectorIds.length} target={{ kind: 'connectors', project }} onSelect={onSelect} />
      </Col>
      <AgentActions agent={agent} name={name} />
    </Col>
  );
}
