import { isRecord, str } from '../read.js';
import { call } from './client.js';
import { builtInDaemon } from '../auth/daemon.js';

export interface AppGrant {
  id: string;
  client: string;
  returnTo: string;
  expiresAt: number;
}

const grantUrl = (id: string): string => `${builtInDaemon()}/api/oauth/grants/${encodeURIComponent(id)}`;
const unexpected = (): Error => new Error('Metro returned an unexpected response.');

export async function fetchAppGrant(id: string): Promise<AppGrant> {
  const body = await call({ method: 'GET', base: grantUrl(id) });
  const grant = isRecord(body) ? body.grant : undefined;
  if (!isRecord(grant) || typeof grant.expiresAt !== 'number') throw unexpected();
  return { id: str(grant.id), client: str(grant.client), returnTo: str(grant.returnTo), expiresAt: grant.expiresAt };
}

export async function answerAppGrant(id: string, answer: { decision: 'allow'; agent: string } | { decision: 'deny' }): Promise<string> {
  const body = await call({ method: 'POST', base: grantUrl(id), headers: { 'content-type': 'application/json' }, body: JSON.stringify(answer) });
  if (!isRecord(body) || typeof body.redirect !== 'string') throw unexpected();
  return body.redirect;
}
