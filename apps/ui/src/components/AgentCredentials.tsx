import { type ReactNode } from 'react';
import { type AgentSummary } from '../api/client.js';
import { CopyBlock } from './CopyBlock.js';
import { ResetAgentKey } from './ResetAgentKey.js';

interface AgentCredentialsProps {
  agent: AgentSummary;
  onReset: (id: string) => Promise<void>;
}

export function AgentCredentials({ agent, onReset }: AgentCredentialsProps): ReactNode {
  if (agent.command === null) return null;
  return (
    <CopyBlock
      key={agent.command}
      label="add to claude code"
      value={agent.command}
      hide={agent.key}
      secret
      actions={<ResetAgentKey agent={agent} onReset={onReset} />}
    />
  );
}
