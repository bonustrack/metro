import { type ReactNode } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { type AgentSummary } from '../api/client';
import { CopyBlock } from './CopyBlock';

interface RevealedKey {
  name: string;
  key: string;
  command: string | null;
}

function revealedKeys(agent: AgentSummary): RevealedKey[] {
  const out: RevealedKey[] = [];
  for (const entry of agent.keys)
    if (entry.key !== null)
      out.push({ name: entry.name, key: entry.key, command: entry.command });
  return out;
}

interface AgentCredentialsProps {
  agent: AgentSummary;
  endpoint: string;
}

export function AgentCredentials({ agent, endpoint }: AgentCredentialsProps): ReactNode {
  const usable = revealedKeys(agent);
  const many = usable.length > 1;
  return (
    <Col gap={12}>
      {endpoint !== '' ? <CopyBlock label="mcp endpoint" value={endpoint} /> : null}
      {usable.map((entry) => (
        <Col key={entry.name} gap={12}>
          <CopyBlock
            label={many ? `api key · ${entry.name}` : 'api key'}
            value={entry.key}
            secret
          />
          {entry.command !== null ? (
            <CopyBlock
              label={many ? `add to claude code · ${entry.name}` : 'add to claude code'}
              value={entry.command}
            />
          ) : null}
        </Col>
      ))}
      {usable.length === 0 && agent.keys.length > 0 ? (
        <Text size="2xs" role="secondary">
          API keys are only shown for agents you own.
        </Text>
      ) : null}
    </Col>
  );
}
