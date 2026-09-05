import { call } from './client';
import { isRecord } from './accounts';
import { daemonBase } from '../auth/daemon';

export interface TerminalStatus {
  available: boolean;
  session: string;
}

const unexpected = (): Error => new Error('Metro returned an unexpected response.');

export async function terminalStatus(): Promise<TerminalStatus> {
  const body = await call({ method: 'GET', base: `${daemonBase()}/api/terminal` });
  if (!isRecord(body) || typeof body.available !== 'boolean') throw unexpected();
  return { available: body.available, session: typeof body.session === 'string' ? body.session : 'metro' };
}

export async function mintTerminalTicket(): Promise<string> {
  const body = await call({ method: 'POST', base: `${daemonBase()}/api/terminal/tickets` });
  if (!isRecord(body) || typeof body.path !== 'string') throw unexpected();
  return body.path;
}

export function terminalSocketUrl(path: string, base = daemonBase()): string {
  return `${base.replace(/^http/, 'ws')}${path}`;
}
