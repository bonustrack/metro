import { call } from './client.js';
import { isRecord } from './accounts.js';
import { daemonBase } from '../auth/daemon.js';

export interface TerminalStatus {
  available: boolean;
  sessions: string[];
}

const REMEMBERED = 'metro.terminal.session';

export function rememberedSession(base: string, sessions: string[]): string | null {
  try {
    const held = localStorage.getItem(`${REMEMBERED}:${base}`);
    return held !== null && sessions.includes(held) ? held : null;
  } catch {
    return null;
  }
}

export function rememberSession(base: string, session: string): void {
  try {
    localStorage.setItem(`${REMEMBERED}:${base}`, session);
  } catch {
    return;
  }
}

export const pickSession = (base: string, sessions: string[]): string | null =>
  rememberedSession(base, sessions) ?? sessions[0] ?? null;

export const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

const unexpected = (): Error => new Error('Metro returned an unexpected response.');

export async function terminalStatus(): Promise<TerminalStatus> {
  const body = await call({ method: 'GET', base: `${daemonBase()}/api/terminal` });
  if (!isRecord(body) || typeof body.available !== 'boolean') throw unexpected();
  const sessions = Array.isArray(body.sessions) ? body.sessions.filter((s): s is string => typeof s === 'string') : [];
  return { available: body.available, sessions };
}

export async function mintTerminalTicket(session: string): Promise<string> {
  const body = await call({
    method: 'POST',
    base: `${daemonBase()}/api/terminal/tickets`,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session }),
  });
  if (!isRecord(body) || typeof body.path !== 'string') throw unexpected();
  return body.path;
}

export function terminalSocketUrl(path: string, base = daemonBase()): string {
  return `${base.replace(/^http/, 'ws')}${path}`;
}

export async function fetchTmuxBuffer(): Promise<string> {
  const body = await call({ method: 'GET', base: `${daemonBase()}/api/terminal/buffer` });
  if (!isRecord(body) || typeof body.text !== 'string') throw unexpected();
  return body.text;
}
