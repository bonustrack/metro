import { type ReactNode } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { type AgentSummary } from '../api/client';
import { CopyBlock } from './CopyBlock';

interface AgentCredentialsProps {
  agent: AgentSummary;
  endpoint: string;
}

export function AgentCredentials({ agent, endpoint }: AgentCredentialsProps): ReactNode {
  return (
    <Col gap={12}>
      {endpoint !== '' ? <CopyBlock label="mcp endpoint" value={endpoint} /> : null}
      {agent.key !== null ? (
        <CopyBlock label="api key" value={agent.key} secret />
      ) : null}
      {agent.command !== null ? (
        <CopyBlock label="add to claude code" value={agent.command} />
      ) : null}
      {agent.key === null && !agent.owned ? (
        <Text size="2xs" role="secondary">
          The API key is only shown for agents you own.
        </Text>
      ) : null}
    </Col>
  );
}
