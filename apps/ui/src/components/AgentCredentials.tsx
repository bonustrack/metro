import { type ReactNode } from 'react';
import { type AgentSummary } from '../api/client';
import { CopyBlock } from './CopyBlock';
import { ResetAgentKey } from './ResetAgentKey';

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
