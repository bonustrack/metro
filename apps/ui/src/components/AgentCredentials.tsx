import { type ReactNode } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { Text } from './ui';
import { type AgentSummary } from '../api/client';
import { CopyBlock } from './CopyBlock';
import { ResetAgentKey } from './ResetAgentKey';

interface AgentCredentialsProps {
  agent: AgentSummary;
  onReset: (id: string) => Promise<void>;
}

export function AgentCredentials({
  agent,
  onReset,
}: AgentCredentialsProps): ReactNode {
  return (
    <Col gap={12}>
      {agent.command !== null ? (
        <CopyBlock
          key={agent.command}
          label="add to claude code"
          value={agent.command}
          hide={agent.key}
          secret
          actions={
            agent.owned ? <ResetAgentKey agent={agent} onReset={onReset} /> : null
          }
        />
      ) : null}
      {agent.command === null && !agent.owned ? (
        <Text size="sm" role="secondary">
          The registration command is only shown for agents you own.
        </Text>
      ) : null}
    </Col>
  );
}
