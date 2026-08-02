import { type ReactNode, useState } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import {
  createAgent,
  deleteAgent,
  type CreatedAgent,
  type Dashboard as DashboardData,
} from '../api/client';
import { AccountList } from './AccountList';
import { AgentHeader } from './AgentHeader';
import { AgentList } from './AgentList';
import { CreateAgent } from './CreateAgent';
import { NewAgentKey } from './NewAgentKey';

interface DashboardProps {
  token: string;
  data: DashboardData;
  expiresAt: number;
  onRefresh: () => void;
  onLock: () => void;
}

export function Dashboard({
  token,
  data,
  expiresAt,
  onRefresh,
  onLock,
}: DashboardProps): ReactNode {
  const [created, setCreated] = useState<CreatedAgent | null>(null);

  const onCreate = async (name: string): Promise<void> => {
    const agent = await createAgent(token, name);
    setCreated(agent);
    onRefresh();
  };

  const onDelete = async (id: number): Promise<void> => {
    await deleteAgent(token, id);
    if (created?.id === id) setCreated(null);
    onRefresh();
  };

  return (
    <Col
      gap={20}
      style={{ maxWidth: 820, marginLeft: 'auto', marginRight: 'auto', width: '100%', padding: 24 }}
    >
      <AgentHeader data={data} expiresAt={expiresAt} onLock={onLock} />
      {created !== null ? (
        <NewAgentKey
          created={created}
          onDismiss={() => {
            setCreated(null);
          }}
        />
      ) : null}
      <AgentList agents={data.agents} onDelete={onDelete} />
      <CreateAgent onCreate={onCreate} />
      <AccountList groups={data.groups} />
    </Col>
  );
}
