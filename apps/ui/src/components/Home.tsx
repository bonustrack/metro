import { type ReactNode, useEffect, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { useQueryClient } from '@tanstack/react-query';
import { Text, Button } from './ui.js';
import { PageTitle } from './PageTitle.js';
import { AgentCredentials } from './AgentCredentials.js';
import { ExportAgent } from './ExportAgent.js';
import { ImportAgent } from './ImportAgent.js';
import { Loading } from './Loading.js';
import { createAgent, resetAgentKey } from '../api/client.js';
import { stationCount } from '../api/accounts.js';
import { queryError, refreshAgents, useServersQuery, useStationsQuery } from '../api/queries.js';
import { currentServer } from '../auth/daemon.js';
import { AGENT_NAME_RE } from '../api/agent-name.js';
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

function agentNameFor(server: { name: string | null; host: string } | undefined, fallback: string): string {
  const wanted = server?.name ?? server?.host.split('.')[0] ?? fallback;
  return AGENT_NAME_RE.test(wanted) ? wanted : 'agent';
}

function NoAgent({ project }: { project: string }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const client = useQueryClient();
  const servers = useServersQuery();
  const here = currentServer();
  const name = servers.data === undefined ? null : agentNameFor(servers.data.find((s) => s.id === here?.id), project);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (name === null) return;
    setError(null);
    createAgent(name)
      .then(() => {
        refreshAgents(client);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Could not create the agent.');
      });
  }, [name, attempt, client]);
  return (
    <Col gap={16}>
      <PageTitle>This machine</PageTitle>
      {error === null ? (
        <Text size="sm" role="secondary">{name === null ? 'Setting up…' : `Setting up ${name}…`}</Text>
      ) : (
        <Col gap={12}>
          <Text size="sm" role="danger">{error}</Text>
          <Row>
            <Button
              color="secondary"
              dark={dark}
              label="Try again"
              onPress={() => {
                setAttempt((n) => n + 1);
              }}
            />
          </Row>
        </Col>
      )}
    </Col>
  );
}

interface HomeProps {
  project: string;
  onSelect: (selection: Selection) => void;
}

function AgentActions({ agent }: { agent: AgentSummary }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const portable = { id: agent.id, name: agent.name, key: agent.key ?? '' };
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
  useDocumentTitle(agent?.name ?? 'This machine');
  if (error !== null) return <Text size="sm" role="danger">{queryError(error, FALLBACK)}</Text>;
  if (data === undefined) return <Loading />;
  if (agent === undefined)
    return (
      <NoAgent project={project} />
    );
  return (
    <Col gap={20}>
      <Col gap={8}>
        <PageTitle>{agent.name}</PageTitle>
        <Text size="sm" role="secondary">
          id {agent.id} · runs on this machine, so its messages never pass through Metro&apos;s servers
        </Text>
      </Col>
      <AgentCredentials
        agent={agent}
        onReset={async (id) => {
          await resetAgentKey(id);
          refreshAgents(client);
        }}
      />
      <Col>
        <Summary label="Channels" count={stationCount(data.groups, agent.id)} target={{ kind: 'stations', project }} onSelect={onSelect} />
        <Summary label="Connectors" count={agent.connectorIds.length} target={{ kind: 'connectors', project }} onSelect={onSelect} />
      </Col>
      <AgentActions agent={agent} />
    </Col>
  );
}
