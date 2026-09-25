import { daemonBase } from '../auth/daemon.js';
import { call } from './client.js';
import { filled, isRecord } from './read.js';

export const METRO_USER_SINCE = '0.1.0-beta.199';

export interface MetroUser {
  runningAs: 'root' | 'metro' | 'other';
  canMove: boolean;
  move: string | null;
  log: string;
  helperCurrent: boolean;
}

export function toMetroUser(body: unknown): MetroUser {
  if (!isRecord(body)) throw new Error('Metro returned an unexpected response.');
  const runningAs = body.runningAs === 'root' || body.runningAs === 'metro' ? body.runningAs : 'other';
  return { runningAs, canMove: body.canMove === true, move: filled(body.move), log: typeof body.log === 'string' ? body.log : '', helperCurrent: body.helperCurrent !== false };
}

const BASE = (): string => `${daemonBase()}/api/server/metro-user`;

export const fetchMetroUser = async (): Promise<MetroUser> => toMetroUser(await call({ method: 'GET', base: BASE() }));

export const startMetroUserMove = async (): Promise<MetroUser> => toMetroUser(await call({ method: 'POST', base: BASE() }));
