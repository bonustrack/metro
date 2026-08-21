import { type ReactNode } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Text } from './ui';
import { type AgentSummary } from '../api/client';

const ROW_PAD_Y = 12;

interface AgentRowProps {
  agent: AgentSummary;
  onOpen: (id: number) => void;
}

export function AgentRow({ agent, onOpen }: AgentRowProps): ReactNode {
  const palette = useKitPalette();
  return (
    <Row
      align="stretch"
      border={{ bottom: { width: 1, color: palette.border } }}
    >
      <a
        className="row-link"
        href={`#/agent/${String(agent.id)}`}
        onClick={(e) => {
          e.preventDefault();
          onOpen(agent.id);
        }}
      >
        <Col gap={1} flex={1} minWidth={0} padding={{ y: ROW_PAD_Y }}>
          <Text size="lg" weight="semibold" numberOfLines={1}>
            {agent.name}
          </Text>
          <Text size="sm" role="secondary">
            {agent.owned ? `id ${String(agent.id)}` : `id ${String(agent.id)} · not owned`}
          </Text>
        </Col>
      </a>
    </Row>
  );
}
