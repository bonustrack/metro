import { daemonBase } from '../auth/daemon.js';
import { call } from './client.js';
import { awaitRestart } from './control.js';
import { filled, isRecord } from './read.js';

export const AGENT_USER_SINCE = '0.1.0-beta.184';

export interface AgentUserStatus {
  enabled: boolean;
  user: string | null;
  active: boolean;
  supported: boolean;
  reason: string | null;
}

export function toAgentUser(body: unknown): AgentUserStatus {
  if (!isRecord(body) || typeof body.enabled !== 'boolean') throw new Error('Metro returned an unexpected response.');
  return {
    enabled: body.enabled,
    user: filled(body.user),
    active: body.active === true,
    supported: body.supported === true,
    reason: filled(body.reason),
  };
}

export async function fetchAgentUser(): Promise<AgentUserStatus> {
  return toAgentUser(await call({ method: 'GET', base: `${daemonBase()}/api/agent-user` }));
}

export async function switchAgentUser(enabled: boolean): Promise<void> {
  await call({
    method: 'POST',
    base: `${daemonBase()}/api/agent-user`,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
  await awaitRestart();
}
