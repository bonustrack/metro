import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { useQueryClient } from '@tanstack/react-query';
import { Text, Button } from './ui';
import { PageTitle } from './PageTitle';
import { AgentCredentials } from './AgentCredentials';
import { CreateAgent } from './CreateAgent';
import { ImportAgent } from './ImportAgent';
import { SyncAgent } from './SyncAgent';
import { RestoreAgent } from './RestoreAgent';
import { Loading } from './Loading';
import { NewAgentKey } from './NewAgentKey';
import { createAgent, importAgent, resetAgentKey, type CreatedAgent } from '../api/client';
import { stationCount } from '../api/accounts';
import { queryError, refreshAgents, refreshConnectors, useModeQuery, useStationsQuery } from '../api/queries';
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

function NoAgent({ token, onDone }: { token: string; onDone: () => void }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const client = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [created, setCreated] = useState<CreatedAgent | null>(null);
  return (
    <Col gap={16}>
      <PageTitle>This machine</PageTitle>
      <Text size="sm" role="secondary">
        No agent lives here yet. Create one, or bring one over from metro.box.
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
          label="Import from metro.box"
          onPress={() => {
            setImporting(true);
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
        token={token}
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
          setCreated(await createAgent(token, name));
          refreshAgents(client);
        }}
      />
      <ImportAgent
        open={importing}
        onClose={() => {
          setImporting(false);
        }}
        onImport={async (code) => {
          await importAgent(token, code);
          refreshAgents(client);
          onDone();
        }}
      />
    </Col>
  );
}

interface HomeProps {
  token: string;
  project: string;
  onSelect: (selection: Selection) => void;
}

function AgentActions({ token, agent }: { token: string; agent: AgentSummary }): ReactNode {
  const client = useQueryClient();
  const dark = useKitScheme() === 'dark';
  const [importing, setImporting] = useState(false);
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
        <Button
          color="secondary"
          dark={dark}
          label="Import again from metro.box"
          onPress={() => {
            setImporting(true);
          }}
        />
      </Row>
      <SyncAgent
        open={syncing}
        token={token}
        agent={{ id: agent.id, name: agent.name }}
        onClose={() => {
          setSyncing(false);
        }}
        onSynced={() => undefined}
      />
      <ImportAgent
        open={importing}
        onClose={() => {
          setImporting(false);
        }}
        onImport={async (code) => {
          await importAgent(token, code);
          refreshAgents(client);
          refreshConnectors(client);
        }}
      />
    </>
  );
}

export function Home({ token, project, onSelect }: HomeProps): ReactNode {
  const client = useQueryClient();
  const { data, error } = useStationsQuery(token);
  const mode = useModeQuery();
  const version = mode.data?.version ?? null;
  const agent = data?.agents[0];
  useDocumentTitle(agent?.name ?? 'This machine');
  if (error !== null) return <Text size="sm" role="danger">{queryError(error, FALLBACK)}</Text>;
  if (data === undefined) return <Loading />;
  if (agent === undefined)
    return (
      <NoAgent
        token={token}
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
          {version === null ? '' : ` · metro ${version}`}
        </Text>
      </Col>
      <AgentCredentials
        agent={agent}
        onReset={async (id) => {
          await resetAgentKey(token, id);
          refreshAgents(client);
        }}
      />
      <Col>
        <Summary label="Stations" count={stationCount(data.groups, agent.id)} target={{ kind: 'stations', project }} onSelect={onSelect} />
        <Summary label="Connectors" count={agent.connectorIds.length} target={{ kind: 'connectors', project }} onSelect={onSelect} />
      </Col>
      <AgentActions token={token} agent={agent} />
    </Col>
  );
}
