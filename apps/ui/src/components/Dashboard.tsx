import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import {
  createAgent,
  deleteAgent,
  type CreatedAgent,
  type Dashboard as DashboardData,
} from '../api/client';
import { AgentPanel } from './AgentPanel';
import { AgentSidebar } from './AgentSidebar';
import { TopBar } from './TopBar';
import { type Selection } from './selection';

interface DashboardProps {
  token: string;
  data: DashboardData;
  expiresAt: number;
  onRefresh: () => void;
  onLock: () => void;
}

const PAGE = {
  maxWidth: 1040,
  marginLeft: 'auto',
  marginRight: 'auto',
  width: '100%',
  padding: 24,
} as const;

const SIDEBAR = { flexGrow: 1, flexShrink: 1, flexBasis: 220 } as const;
const MAIN = { flexGrow: 5, flexShrink: 1, flexBasis: 400 } as const;

function initialSelection(data: DashboardData): Selection {
  const first = data.agents[0];
  return first === undefined ? { kind: 'new' } : { kind: 'agent', id: first.id };
}

export function Dashboard({
  token,
  data,
  expiresAt,
  onRefresh,
  onLock,
}: DashboardProps): ReactNode {
  const [created, setCreated] = useState<CreatedAgent | null>(null);
  const [picked, setPicked] = useState<Selection>(() => initialSelection(data));

  const onCreate = async (name: string): Promise<void> => {
    const agent = await createAgent(token, name);
    setCreated(agent);
    setPicked({ kind: 'agent', id: agent.id });
    onRefresh();
  };

  const onDelete = async (id: number): Promise<void> => {
    await deleteAgent(token, id);
    if (created?.id === id) setCreated(null);
    setPicked({ kind: 'none' });
    onRefresh();
  };

  const selection: Selection = data.agents.length === 0 ? { kind: 'new' } : picked;

  return (
    <Col gap={24} style={PAGE}>
      <TopBar email={data.email} expiresAt={expiresAt} onLock={onLock} />
      <Row gap={24} wrap align="start">
        <Col style={SIDEBAR}>
          <AgentSidebar
            agents={data.agents}
            groups={data.groups}
            selection={selection}
            onSelect={setPicked}
          />
        </Col>
        <Col style={MAIN}>
          <AgentPanel
            agents={data.agents}
            groups={data.groups}
            unattributed={data.unattributed}
            endpoint={data.endpoint}
            selection={selection}
            created={created}
            onCreate={onCreate}
            onDismiss={() => {
              setCreated(null);
            }}
            onDelete={onDelete}
          />
        </Col>
      </Row>
    </Col>
  );
}
