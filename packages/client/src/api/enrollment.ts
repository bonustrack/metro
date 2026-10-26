import { accountIdentity, accountScopeIdentity, activeAccount, checkAccountIdentity, subscribeAccountScope } from '../auth/account.js';
import { baseFromSegment, builtInDaemon, currentServer, daemonBase, subscribeCurrentServer } from '../auth/daemon.js';
import { isRecord } from '../read.js';
import { AuthError, call, ForbiddenError, NotFoundError } from './client.js';
import type { BoxServer } from './servers.js';
import { toMode } from './mode.js';
import { olderThan } from './version.js';

interface EnrollmentResult {
  server: string;
  organization: string;
}

export interface Enrollment {
  run: () => Promise<EnrollmentResult>;
  dispose: () => void;
}

interface Ticket {
  ticket: string;
  expiresAt: number;
}

const CHANGED = 'The account or agent changed during enrollment. Try again.';
const UNCONFIRMED = 'Enrollment could not be confirmed and may have reached the agent. Try again.';
const DISABLED = 'Organization connectors are not switched on yet.';
const STALE = 'This enrollment ticket is stale or belongs to another organization. Start again from the agent page.';
const UPDATE = 'Update this agent to the latest Metro, then try again.';
const running = new Set<string>();

class EnrollmentError extends Error {}

function ticketOf(value: unknown): Ticket {
  if (!isRecord(value) || typeof value.ticket !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.ticket) || typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt) || value.expiresAt <= Date.now()) throw new EnrollmentError('Metro did not return a valid enrollment ticket. Try again.');
  return { ticket: value.ticket, expiresAt: value.expiresAt };
}

function resultOf(value: unknown, server: string, organization: string): EnrollmentResult {
  if (!isRecord(value) || value.server !== server || value.organization !== organization || typeof value.keyId !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.keyId)) throw new EnrollmentError('Enrollment returned a different or invalid identity and is not confirmed. Check the agent and organization, then try again.');
  return { server, organization };
}

function stageError(error: unknown, stage: 'ticket' | 'agent'): string {
  if (stage === 'agent') {
    if (error instanceof Error && error.message === STALE) return 'The ticket expired or was used. Retry to request a new ticket, which can replace an enrollment the agent already got.';
    return UNCONFIRMED;
  }
  if (error instanceof Error && error.message === DISABLED) return `${DISABLED} Enrollment did not start. No settings were changed.`;
  return 'Could not start enrollment, and nothing changed. Check organization setup, then try again.';
}

function safeError(error: unknown, stage: 'ticket' | 'agent'): Error {
  if (error instanceof EnrollmentError) return error;
  if (error instanceof AuthError) return new EnrollmentError('Sign in again as an organization admin to enroll this agent.');
  if (error instanceof ForbiddenError) return new EnrollmentError('Only an admin of this agent’s organization can enroll it.');
  if (error instanceof NotFoundError) return new EnrollmentError(stage === 'agent' ? UPDATE : 'This agent is no longer in this organization. Reload the page.');
  return new EnrollmentError(stageError(error, stage));
}

function originOf(base: string): string {
  const url = new URL(base);
  if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/' || url.search !== '' || url.hash !== '' || url.username !== '' || url.password !== '') throw new EnrollmentError('This agent has an invalid address. Reload the page.');
  return url.origin;
}

function matchesDestination(id: string, origin: string, central: string): boolean {
  const server = currentServer();
  return server !== null && server.host !== null && server.id === id && originOf(baseFromSegment(server.host)) === origin && originOf(daemonBase()) === origin && builtInDaemon() === central;
}

function checkMode(body: unknown, organization: string | undefined): void {
  const mode = toMode(body);
  if (mode === null || mode.stopped) throw new EnrollmentError('The agent is not running. Start it, then enroll.');
  if (olderThan(mode.version, '0.1.0-beta.288')) throw new EnrollmentError(UPDATE);
  if (mode.owner !== organization) throw new EnrollmentError('This agent does not belong to the selected organization. Enrollment did not start.');
}

export function createEnrollment(server: Pick<BoxServer, 'id' | 'host'>): Enrollment {
  const identity = accountIdentity();
  const organization = identity?.organization ?? '';
  const scope = accountScopeIdentity();
  const id = server.id;
  const origin = originOf(baseFromSegment(server.host));
  const central = builtInDaemon();
  const key = JSON.stringify([scope, id, origin]);
  let ticket: Ticket | null = null;
  let request: AbortController | null = null;
  let disposed = false;
  let finished = false;
  const check = (): void => {
    try { checkAccountIdentity(identity); } catch { throw new EnrollmentError(CHANGED); }
    if (disposed || scope !== accountScopeIdentity() || !matchesDestination(id, origin, central)) throw new EnrollmentError(CHANGED);
    if (activeAccount()?.role !== 'admin') throw new ForbiddenError();
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{10}$/.test(id)) throw new EnrollmentError('Select a registered agent before enrolling.');
    if (request?.signal.aborted === true) throw new EnrollmentError(UNCONFIRMED);
  };
  const dispose = (): void => { disposed = true; ticket = null; request?.abort(); };
  const unsubscribeAccount = subscribeAccountScope(dispose);
  const unsubscribeServer = subscribeCurrentServer(dispose);
  const run = async (): Promise<EnrollmentResult> => {
    let stage: 'ticket' | 'agent' = 'ticket';
    let locked = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      check();
      if (finished || running.has(key)) throw new EnrollmentError('Enrollment is already running or complete.');
      running.add(key);
      locked = true;
      request = new AbortController();
      timer = setTimeout(() => { request?.abort(); }, 45_000);
      const init = { method: 'POST', checkAccount: check, signal: request.signal, redirect: 'error' } as const;
      checkMode(await call({ ...init, method: 'GET', base: `${origin}/api/mode` }), organization);
      if (ticket === null || ticket.expiresAt <= Date.now()) ticket = ticketOf(await call({ ...init, base: `${central}/api/servers/${id}/enrollment` }));
      check();
      stage = 'agent';
      const body = await call({ ...init, base: `${origin}/api/enrollment`, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ticket: ticket.ticket }) });
      check();
      const result = resultOf(body, id, organization);
      ticket = null;
      finished = true;
      return result;
    } catch (error) {
      if (error instanceof Error && error.message === STALE) ticket = null;
      throw safeError(error, stage);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (locked) { running.delete(key); request = null; }
    }
  };
  return { run, dispose: () => { dispose(); unsubscribeAccount(); unsubscribeServer(); } };
}
