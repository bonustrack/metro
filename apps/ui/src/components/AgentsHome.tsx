import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button } from './ui';
import { SHRINK } from '../theme';
import { PageTitle } from './PageTitle';
import { useQueryClient } from '@tanstack/react-query';
import {
  createAgent,
  deleteAgent,
  importAgent,
  type AgentSummary,
  type CreatedAgent,
} from '../api/client';
import {
  agentsKey,
  queryError,
  stationsKey,
  useModeQuery,
  useStationsQuery,
} from '../api/queries';
import { stationCount, type AccountGroup } from '../api/accounts';
import { AgentRow } from './AgentRow';
import { CountBadge } from './CountBadge';
import { CreateAgent } from './CreateAgent';
import { ImportAgent } from './ImportAgent';
import { Loading } from './Loading';
import { NewAgentKey } from './NewAgentKey';
import { useDocumentTitle } from '../title';

const FALLBACK = 'Could not load your agents.';

function AgentCards({
  agents,
  groups,
  project,
  onOpen,
  onDelete,
}: {
  agents: AgentSummary[];
  groups: AccountGroup[];
  project: string;
  onOpen: (id: string) => void;
  onDelete: (id: string) => Promise<void>;
}): ReactNode {
  if (agents.length === 0)
    return <Text size="sm" role="secondary">No agents yet.</Text>;
  return (
    <Col>
      {agents.map((agent) => (
        <AgentRow
          project={project}
          key={agent.id}
          agent={agent}
          stations={stationCount(groups, agent.id)}
          onOpen={onOpen}
          onDelete={onDelete}
        />
      ))}
    </Col>
  );
}

function HomeActions({
  local,
  dark,
  onImport,
  onCreate,
}: {
  local: boolean;
  dark: boolean;
  onImport: () => void;
  onCreate: () => void;
}): ReactNode {
  return (
    <Row gap={8} align="center" wrap>
      {local ? (
        <Button color="secondary" dark={dark} label="Import from metro.box" onPress={onImport} />
      ) : null}
      <Button color="primary" dark={dark} label="New agent" onPress={onCreate} />
    </Row>
  );
}

interface AgentsHomeProps {
  token: string;
  project: string;
  onOpen: (id: string) => void;
}

export function AgentsHome({
  token,
  project,
  onOpen,
}: AgentsHomeProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  const client = useQueryClient();
  const { data, error } = useStationsQuery(token, project);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [created, setCreated] = useState<CreatedAgent | null>(null);
  const local = useModeQuery().data?.mode === 'local';
  useDocumentTitle('Agents');

  const doImport = async (code: string): Promise<void> => {
    const made = await importAgent(token, code);
    await client.invalidateQueries({ queryKey: agentsKey(project) });
    await client.invalidateQueries({ queryKey: stationsKey(project) });
    onOpen(made.id);
  };

  const create = async (name: string): Promise<void> => {
    const agent = await createAgent(token, project, name);
    setCreated(agent);
    await client.invalidateQueries({ queryKey: agentsKey(project) });
    await client.invalidateQueries({ queryKey: stationsKey(project) });
  };

  const remove = async (id: string): Promise<void> => {
    await deleteAgent(token, id);
    await client.invalidateQueries({ queryKey: agentsKey(project) });
    await client.invalidateQueries({ queryKey: stationsKey(project) });
  };

  return (
    <Col gap={16}>
      <Row justify="between" align="start" gap={12} wrap>
        <Col gap={8} style={SHRINK}>
          <Row gap={10} align="center">
            <PageTitle>Agents</PageTitle>
            {data === undefined ? null : (
              <CountBadge count={data.agents.length} beside="title" />
            )}
          </Row>
        </Col>
        <HomeActions
          local={local}
          dark={dark}
          onImport={() => {
            setImporting(true);
          }}
          onCreate={() => {
            setCreating(true);
          }}
        />
      </Row>

      {created === null ? null : (
        <NewAgentKey
          created={created}
          onDismiss={() => {
            setCreated(null);
          }}
        />
      )}

      {error === null ? null : (
        <Text size="sm" role="danger">{queryError(error, FALLBACK)}</Text>
      )}
      {data === undefined && error === null ? <Loading /> : null}
      {data === undefined ? null : (
        <AgentCards
          agents={data.agents}
          groups={data.groups}
          project={project}
          onOpen={onOpen}
          onDelete={remove}
        />
      )}

      <ImportAgent
        open={importing}
        onClose={() => {
          setImporting(false);
        }}
        onImport={doImport}
      />
      <CreateAgent
        open={creating}
        first={data?.agents.length === 0}
        onClose={() => {
          setCreating(false);
        }}
        onCreate={create}
      />
    </Col>
  );
}
