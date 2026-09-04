import { call } from './client';
import { isRecord } from './accounts';

export interface AgentCode {
  code: string;
  expiresAt: number;
  agent: string;
}

export async function mintAgentCode(
  token: string,
  agentId: string,
  daemon?: string,
): Promise<AgentCode> {
  const body = await call(token, {
    method: 'POST',
    path: `/${agentId}/code`,
    ...(daemon === undefined ? {} : { base: `${daemon}/api/agents` }),
  });
  if (
    !isRecord(body) ||
    typeof body.code !== 'string' ||
    typeof body.agent !== 'string'
  )
    throw new Error('Metro returned an unexpected response.');
  return {
    code: body.code,
    agent: body.agent,
    expiresAt: typeof body.expiresAt === 'number' ? body.expiresAt : 0,
  };
}
