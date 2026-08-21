import { type ReactNode } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { Card } from '@stage-labs/kit/react-native/card';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text } from './ui';
import { CARD_PADDING } from '../theme';
import { deleteAgent } from '../api/client';
import { useStations } from '../api/stations';
import { AgentDetail } from './AgentDetail';
import { Loading } from './Loading';
import { useDocumentTitle } from '../title';

interface AgentPageProps {
  token: string;
  id: number;
  onOpenStation: (accountId: string) => void;
  onGone: () => void;
}

function Notice({ text }: { text: string }): ReactNode {
  const dark = useKitScheme() === 'dark';
  return (
    <Card dark={dark} padding={CARD_PADDING}>
      <Text role="secondary">{text}</Text>
    </Card>
  );
}

export function AgentPage(props: AgentPageProps): ReactNode {
  const { token, id, onOpenStation, onGone } = props;
  const { data, error, reload } = useStations(token);
  const agent = data?.agents.find((a) => a.id === id);
  useDocumentTitle(agent?.name ?? 'Agent');

  if (error !== null) return <Text size="sm" role="danger">{error}</Text>;
  if (data === null) return <Loading />;
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
        onChanged={reload}
        onDelete={async (agentId) => {
          await deleteAgent(token, agentId);
          onGone();
        }}
      />
    </Col>
  );
}
