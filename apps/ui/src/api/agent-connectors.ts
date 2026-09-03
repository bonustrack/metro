import { call } from './client';
import { isRecord } from './accounts';

export interface AgentConnectors {
  id: string;
  name: string;
  connectorIds: string[];
}

export interface AgentCode {
  code: string;
  expiresAt: number;
  agent: string;
}

const json = (body: unknown): { headers: Record<string, string>; body: string } => ({
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

function toAgentConnectors(value: unknown): AgentConnectors {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.name !== 'string')
    throw new Error('Metro returned an unexpected response.');
  const ids = value.connectorIds;
  return {
    id: value.id,
    name: value.name,
    connectorIds: Array.isArray(ids)
      ? ids.filter((v): v is string => typeof v === 'string')
      : [],
  };
}

export async function addAgentConnector(
  token: string,
  agentId: string,
  connectorId: string,
): Promise<AgentConnectors> {
  return toAgentConnectors(
    await call(token, {
      method: 'POST',
      path: `/${agentId}/connectors`,
      ...json({ connectorId }),
    }),
  );
}

export async function removeAgentConnector(
  token: string,
  agentId: string,
  connectorId: string,
): Promise<AgentConnectors> {
  return toAgentConnectors(
    await call(token, {
      method: 'DELETE',
      path: `/${agentId}/connectors/${connectorId}`,
    }),
  );
}

export async function setAgentConnectors(
  token: string,
  agentId: string,
  current: string[],
  next: string[],
): Promise<void> {
  const added = next.filter((id) => !current.includes(id));
  const dropped = current.filter((id) => !next.includes(id));
  for (const id of added) await addAgentConnector(token, agentId, id);
  for (const id of dropped) await removeAgentConnector(token, agentId, id);
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
