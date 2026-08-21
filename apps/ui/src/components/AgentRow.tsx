import { type ReactNode } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Text } from './ui';
import { AgentAvatar } from './AgentAvatar';
import { DeleteAgent } from './DeleteAgent';
import { opensElsewhere } from './link';
import { type AgentSummary } from '../api/client';

const ROW_PAD_Y = 12;
const AVATAR_SIZE = 32;

function summary(agent: AgentSummary, stations: number): string {
  const label = `${String(stations)} station${stations === 1 ? '' : 's'}`;
  return agent.owned ? label : `${label} · not owned`;
}

interface AgentRowProps {
  agent: AgentSummary;
  stations: number;
  onOpen: (id: string) => void;
  onDelete: (id: string) => Promise<void>;
}

export function AgentRow({
  agent,
  stations,
  onOpen,
  onDelete,
}: AgentRowProps): ReactNode {
  const palette = useKitPalette();
  return (
    <Row
      justify="between"
      align="stretch"
      gap={12}
      border={{ bottom: { width: 1, color: palette.border } }}
    >
      <a
        className="row-link"
        href={`#/agent/${agent.id}`}
        onClick={(e) => {
          if (opensElsewhere(e)) return;
          e.preventDefault();
          onOpen(agent.id);
        }}
      >
        <AgentAvatar seed={agent.id} size={AVATAR_SIZE} />
        <Col gap={1} flex={1} minWidth={0} padding={{ y: ROW_PAD_Y }}>
          <Text size="xl" weight="semibold" numberOfLines={1}>
            {agent.name}
          </Text>
          <Text size="sm" role="secondary">
            {summary(agent, stations)}
          </Text>
        </Col>
      </a>
      {agent.owned ? (
        <Row align="center" padding={{ y: ROW_PAD_Y }}>
          <DeleteAgent agent={agent} onDelete={onDelete} />
        </Row>
      ) : null}
    </Row>
  );
}
