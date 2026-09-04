import { call } from './client';
import { isRecord } from './accounts';
import { daemonBase } from '../auth/session';

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

const updateUrl = (): string => `${daemonBase()}/api/update`;
const unexpected = (): Error => new Error('Metro returned an unexpected response.');

export async function fetchUpdate(token: string): Promise<UpdateCheck> {
  const body = await call(token, { method: 'GET', base: updateUrl() });
  if (!isRecord(body) || typeof body.current !== 'string' || typeof body.latest !== 'string') throw unexpected();
  return {
    running: typeof body.running === 'string' ? body.running : body.current,
    current: body.current,
    latest: body.latest,
    newer: body.newer === true,
  };
}

export async function runUpdate(token: string): Promise<UpdateResult> {
  const body = await call(token, { method: 'POST', base: updateUrl() });
  if (!isRecord(body) || typeof body.version !== 'string') throw unexpected();
  return { updated: body.updated === true, version: body.version, restarting: body.restarting === true };
}
