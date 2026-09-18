import { call } from './client.js';
import { isRecord } from './accounts.js';
import { daemonBase } from '../auth/daemon.js';

export const isOrganizationId = (value: string | null): value is string => value !== null && /^org_[A-Za-z0-9]{10,64}$/.test(value);

export async function claimBox(organization: string): Promise<{ owner: string; previous: string }> {
  const body = await call({ method: 'POST', base: `${daemonBase()}/api/owner`, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ owner: organization }) });
  if (!isRecord(body) || typeof body.owner !== 'string' || typeof body.previous !== 'string') throw new Error('Metro returned an unexpected response.');
  return { owner: body.owner, previous: body.previous };
}
