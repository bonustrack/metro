import { baseFromSegment, daemonBase } from '../auth/daemon.js';
import { call, callBearer } from './client.js';
import { scopedOrganizationAccessToken } from './auth.js';
import { isRecord } from '../read.js';
import { noteUpdate } from './servers.js';

export interface UpdateCheck {
  running: string;
  current: string;
  latest: string;
  newer: boolean;
}

export interface UpdateResult {
  updated: boolean;
  version: string;
  restarting: boolean;
}

const updateUrl = (base = daemonBase()): string => `${base}/api/update`;
const unexpected = (): Error => new Error('Metro returned an unexpected response.');

export async function fetchUpdate(): Promise<UpdateCheck> {
  const body = await call({ method: 'GET', base: updateUrl() });
  if (!isRecord(body) || typeof body.current !== 'string' || typeof body.latest !== 'string') throw unexpected();
  return {
    running: typeof body.running === 'string' ? body.running : body.current,
    current: body.current,
    latest: body.latest,
    newer: body.newer === true,
  };
}

function updateResult(base: string, body: unknown): UpdateResult {
  if (!isRecord(body) || typeof body.version !== 'string') throw unexpected();
  const result = { updated: body.updated === true, version: body.version, restarting: body.restarting === true };
  if (result.restarting) noteUpdate(base, result.version);
  return result;
}

export async function runUpdate(): Promise<UpdateResult> {
  const base = daemonBase();
  return updateResult(base, await call({ method: 'POST', base: updateUrl(base) }));
}

export async function updateAgentIn(organization: string, host: string): Promise<UpdateResult> {
  const base = baseFromSegment(host);
  const token = await scopedOrganizationAccessToken(organization);
  return updateResult(base, await callBearer({ method: 'POST', base: updateUrl(base) }, token));
}
