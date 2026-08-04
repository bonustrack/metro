import { type ReactNode } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { Text } from './ui';
import { type AgentSummary } from '../api/client';
import { CopyBlock } from './CopyBlock';
import { ResetAgentKey } from './ResetAgentKey';

interface AgentCredentialsProps {
  agent: AgentSummary;
  endpoint: string;
  onReset: (id: number) => Promise<void>;
}

export function AgentCredentials({
  agent,
  endpoint,
  onReset,
}: AgentCredentialsProps): ReactNode {
  return (
    <Col gap={12}>
      {endpoint !== '' ? <CopyBlock label="mcp endpoint" value={endpoint} /> : null}
      {agent.key !== null ? (
        <CopyBlock key={agent.key} label="api key" value={agent.key} secret />
      ) : null}
      {agent.command !== null ? (
        <CopyBlock key={agent.command} label="add to claude code" value={agent.command} />
      ) : null}
      {agent.key === null && !agent.owned ? (
        <Text size="2xs" role="secondary">
          The API key is only shown for agents you own.
        </Text>
      ) : null}
      {agent.owned ? <ResetAgentKey agent={agent} onReset={onReset} /> : null}
    </Col>
  );
}
