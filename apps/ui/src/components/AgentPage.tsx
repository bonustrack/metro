import { type ReactNode } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { Text } from './ui';
import { useQueryClient } from '@tanstack/react-query';
import { deleteAgent } from '../api/client';
import {
  agentsKey,
  queryError,
  stationsKey,
  useStationsQuery,
} from '../api/queries';
import { AgentDetail } from './AgentDetail';
import { Loading } from './Loading';
import { useDocumentTitle } from '../title';

const FALLBACK = 'Could not load this agent.';

interface AgentPageProps {
  token: string;
  id: string;
  onOpenStation: (accountId: string) => void;
  onGone: () => void;
  onBack: () => void;
}

function Notice({ text }: { text: string }): ReactNode {
  return (
    <Text role="secondary">{text}</Text>
  );
}

export function AgentPage(props: AgentPageProps): ReactNode {
  const { token, id, onOpenStation, onGone, onBack } = props;
  const client = useQueryClient();
  const { data, error } = useStationsQuery(token);
  const refresh = (): void => {
    client
      .invalidateQueries({ queryKey: stationsKey() })
      .catch(() => undefined);
  };
  const agent = data?.agents.find((a) => a.id === id);
  useDocumentTitle(agent?.name ?? 'Agent');

  if (error !== null)
    return <Text size="sm" role="danger">{queryError(error, FALLBACK)}</Text>;
  if (data === undefined) return <Loading />;
  if (agent === undefined)
    return (
      <Notice text="No agent with that id is available to this account." />
    );

  return (
    <Col gap={16}>
      <AgentDetail
        token={token}
        agent={agent}
        groups={data.groups}
        attachable={data.attachable}
        unattributed={data.unattributed}
        onOpenStation={onOpenStation}
        onBack={onBack}
        onChanged={refresh}
        onDelete={async (agentId) => {
          await deleteAgent(token, agentId);
          await client.invalidateQueries({ queryKey: agentsKey() });
          await client.invalidateQueries({ queryKey: stationsKey() });
          onGone();
        }}
      />
    </Col>
  );
}
