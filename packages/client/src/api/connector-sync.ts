import type { ConnectorSyncStatus } from '@metro-labs/core/connector-sync';
import { accountIdentity, accountScopeIdentity, activeAccount, checkAccountIdentity, subscribeAccountScope } from '../auth/account.js';
import { baseFromSegment, builtInDaemon, currentServer, daemonBase, subscribeCurrentServer } from '../auth/daemon.js';
import { accessToken } from './auth.js';
import { AuthError, callBearer, ForbiddenError, NotFoundError } from './client.js';
import { connectorSyncStatusOf, SYNC_UNAVAILABLE } from './connector-sync-status.js';
import { enrollmentRunning, enrollmentScopeIdentity, subscribeEnrollmentScope } from './enrollment-scope.js';
import { toMode } from './mode.js';
import type { Server } from './servers.js';
import { olderThan } from './version.js';

export const CONNECTOR_SYNC_SINCE = '0.1.0-beta.289';
export const CONNECTOR_SYNC_UPDATE = 'Update this agent’s Metro to manage connector sync, then refresh status.';
const CHANGED = 'The account, agent or enrollment changed. Refresh this page first.';
const SAVE_FAILED = 'The sync change could not be confirmed and may have reached the agent. Refresh status first.';

export interface ConnectorSync {
  read: () => Promise<ConnectorSyncStatus>;
  save: (enabled: boolean) => Promise<ConnectorSyncStatus>;
  dispose: () => void;
}

class SyncError extends Error {}

function originOf(base: string): string {
  const url = new URL(base);
  if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/' || url.search !== '' || url.hash !== '' || url.username !== '' || url.password !== '') throw new SyncError(CHANGED);
  return url.origin;
}

function matchesDestination(id: string, origin: string, central: string): boolean {
  const selected = currentServer();
  return selected !== null && selected.id === id && originOf(baseFromSegment(selected.host)) === origin && originOf(daemonBase()) === origin && builtInDaemon() === central;
}

function captureScope(server: Pick<Server, 'id' | 'host'>) {
  const identity = accountIdentity();
  const account = accountScopeIdentity();
  const enrollment = enrollmentScopeIdentity();
  const central = builtInDaemon();
  const id = server.id;
  const origin = originOf(baseFromSegment(server.host));
  const check = (): void => {
    try { checkAccountIdentity(identity); } catch { throw new SyncError(CHANGED); }
    if (account !== accountScopeIdentity() || enrollment !== enrollmentScopeIdentity() || enrollmentRunning() || !matchesDestination(id, origin, central)) throw new SyncError(CHANGED);
    if (activeAccount()?.role !== 'admin') throw new ForbiddenError();
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{10}$/.test(id)) throw new SyncError(CHANGED);
  };
  return { check, id, origin, organization: identity?.organization ?? '' };
}

function safeError(error: unknown, saving: boolean): Error {
  if (error instanceof SyncError) return error;
  if (error instanceof AuthError) return new SyncError('Sign in again as an organization admin to manage connector sync.');
  if (error instanceof ForbiddenError) return new SyncError('Only an admin of this agent’s organization can manage connector sync.');
  if (error instanceof NotFoundError) return new SyncError(CONNECTOR_SYNC_UPDATE);
  return new SyncError(saving ? SAVE_FAILED : SYNC_UNAVAILABLE);
}

function checkMode(body: unknown, organization: string): void {
  const mode = toMode(body);
  if (mode === null || mode.stopped) throw new SyncError('Start Metro on this agent first.');
  if (olderThan(mode.version, CONNECTOR_SYNC_SINCE)) throw new SyncError(CONNECTOR_SYNC_UPDATE);
  if (mode.owner !== organization) throw new SyncError(CHANGED);
}

function saveBody(status: ConnectorSyncStatus | null, enabled: boolean) {
  if (status === null) throw new SyncError('Refresh status before changing connector sync.');
  if (enabled && !status.enrolled) throw new SyncError('Enroll this agent with the organization before enabling sync.');
  if (enabled && status.liveEnabled) throw new SyncError('Live organization tools are on in the server environment. Turn them off before turning on sync.');
  return { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled, scope: status.scope }) };
}

export function createConnectorSync(server: Pick<Server, 'id' | 'host'>): ConnectorSync {
  const scope = captureScope(server);
  let status: ConnectorSyncStatus | null = null;
  let disposed = false;
  let request: AbortController | null = null;
  const dispose = (): void => { disposed = true; status = null; request?.abort(); };
  const subscriptions = [subscribeAccountScope(dispose), subscribeCurrentServer(dispose), subscribeEnrollmentScope(dispose)];
  const check = (): void => {
    scope.check();
    if (disposed) throw new SyncError(CHANGED);
    if (request?.signal.aborted === true) throw new Error('Request ended');
  };
  const perform = async (controller: AbortController, enabled?: boolean): Promise<ConnectorSyncStatus> => {
    const saving = enabled !== undefined;
    const previous = status;
    const body = enabled === undefined ? {} : saveBody(previous, enabled);
    const token = await accessToken();
    check();
    if (token === null) throw new AuthError('not signed in');
    const init = { checkAccount: check, signal: controller.signal };
    checkMode(await callBearer({ ...init, method: 'GET', base: `${scope.origin}/api/mode` }, token), scope.organization);
    check();
    const response = await callBearer({ ...init, base: `${scope.origin}/api/connectors/sync`, method: saving ? 'PUT' : 'GET', ...body }, token);
    check();
    const next = connectorSyncStatusOf(response, scope.organization, scope.id);
    if (saving && (next.scope !== previous?.scope || next.enabled !== enabled)) throw new SyncError(SAVE_FAILED);
    status = next;
    return next;
  };
  const run = async (enabled?: boolean): Promise<ConnectorSyncStatus> => {
    if (request !== null) throw new SyncError('Connector sync status is already being checked or saved.');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      check();
      request = new AbortController();
      timer = setTimeout(() => { request?.abort(); }, 15_000);
      return await perform(request, enabled);
    } catch (error) {
      status = null;
      if (disposed) throw new SyncError(CHANGED);
      throw safeError(error, enabled !== undefined);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      request = null;
    }
  };
  return { read: () => run(), save: (enabled) => run(enabled), dispose: () => { dispose(); for (const unsubscribe of subscriptions) unsubscribe(); } };
}
