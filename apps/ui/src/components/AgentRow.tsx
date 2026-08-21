import { type ReactNode } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Text } from './ui';
import { DeleteAgent } from './DeleteAgent';
import { type AgentSummary } from '../api/client';

const ROW_PAD_Y = 12;

interface AgentRowProps {
  agent: AgentSummary;
  onOpen: (id: string) => void;
  onDelete: (id: string) => Promise<void>;
}

export function AgentRow({ agent, onOpen, onDelete }: AgentRowProps): ReactNode {
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
          e.preventDefault();
          onOpen(agent.id);
        }}
      >
        <Col gap={1} flex={1} minWidth={0} padding={{ y: ROW_PAD_Y }}>
          <Text size="lg" weight="semibold" numberOfLines={1}>
            {agent.name}
          </Text>
          <Text size="sm" role="secondary">
            {agent.owned ? `id ${agent.id}` : `id ${agent.id} · not owned`}
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
