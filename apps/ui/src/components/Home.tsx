import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { useQueryClient } from '@tanstack/react-query';
import { Text, Button } from './ui';
import { PageTitle } from './PageTitle';
import { AgentCredentials } from './AgentCredentials';
import { CreateAgent } from './CreateAgent';
import { SyncAgent } from './SyncAgent';
import { RestoreAgent } from './RestoreAgent';
import { Loading } from './Loading';
import { NewAgentKey } from './NewAgentKey';
import { createAgent, resetAgentKey, type CreatedAgent } from '../api/client';
import { stationCount } from '../api/accounts';
import { queryError, refreshAgents, refreshConnectors, useStationsQuery } from '../api/queries';
import { type AgentSummary } from '../api/client';
import { routeHash } from '../route';
import { opensElsewhere } from './link';
import { type Selection } from './selection';
import { useDocumentTitle } from '../title';

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

function NoAgent({ onDone }: { onDone: () => void }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const client = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [created, setCreated] = useState<CreatedAgent | null>(null);
  return (
    <Col gap={16}>
      <PageTitle>This machine</PageTitle>
      <Text size="sm" role="secondary">
        No agent lives here yet. Create one, or restore one you synced to Metro.
      </Text>
      <Row gap={8} wrap>
        <Button
          color="primary"
          dark={dark}
          label="Create agent"
          onPress={() => {
            setCreating(true);
          }}
        />
        <Button
          color="secondary"
          dark={dark}
          label="Restore from Metro"
          onPress={() => {
            setRestoring(true);
          }}
        />
      </Row>
      <RestoreAgent
        open={restoring}
        onClose={() => {
          setRestoring(false);
        }}
        onRestored={() => {
          refreshAgents(client);
          refreshConnectors(client);
          onDone();
        }}
      />
      {created === null ? null : (
        <NewAgentKey
          created={created}
          onDismiss={() => {
            setCreated(null);
          }}
        />
      )}
      <CreateAgent
        open={creating}
        first
        onClose={() => {
          setCreating(false);
        }}
        onCreate={async (name) => {
          setCreated(await createAgent(name));
          refreshAgents(client);
        }}
      />
    </Col>
  );
}

interface HomeProps {
  project: string;
  onSelect: (selection: Selection) => void;
}

function AgentActions({ agent }: { agent: AgentSummary }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [syncing, setSyncing] = useState(false);
  return (
    <>
      <Row gap={8} wrap>
        <Button
          color="primary"
          dark={dark}
          label="Sync with Metro"
          onPress={() => {
            setSyncing(true);
          }}
        />
      </Row>
      <SyncAgent
        open={syncing}
        agent={{ id: agent.id, name: agent.name }}
        onClose={() => {
          setSyncing(false);
        }}
        onSynced={() => undefined}
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
      <NoAgent
        onDone={() => {
          onSelect({ kind: 'stations', project });
        }}
      />
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
