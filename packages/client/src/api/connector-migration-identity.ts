import { accountIdentity, accountScopeIdentity, activeAccount, checkAccountIdentity, subscribeAccountScope } from '../auth/account.js';
import { baseFromSegment, builtInDaemon, currentServer, daemonBase, subscribeCurrentServer } from '../auth/daemon.js';
import { ForbiddenError } from './client.js';
import { enrollmentRunning, enrollmentScopeIdentity, subscribeEnrollmentScope } from './enrollment-scope.js';

export const MIGRATION_CHANGED = 'The account, agent or enrollment changed. Close this dialog and open it again. An in-flight change may have reached the agent; refresh its migration status before continuing.';

export interface MigrationIdentity {
  base: string;
  owner: string | null;
  agentId: string | null;
  signal: AbortSignal;
  check: () => void;
  invalidate: () => void;
  dispose: () => void;
}

function sameDestination(server: ReturnType<typeof currentServer>, base: string, central: string): boolean {
  const selected = currentServer();
  if (base !== daemonBase() || central !== builtInDaemon()) return false;
  if (server === null) return selected === null;
  return selected !== null && server.id === selected.id && server.host === selected.host && base === baseFromSegment(server.host);
}

export function captureMigrationIdentity(onInvalidate?: () => void): MigrationIdentity {
  const identity = accountIdentity();
  const account = accountScopeIdentity();
  const enrollment = enrollmentScopeIdentity();
  const server = currentServer();
  const base = daemonBase();
  const central = builtInDaemon();
  const controller = new AbortController();
  const invalidate = (): void => {
    if (controller.signal.aborted) return;
    controller.abort();
    onInvalidate?.();
  };
  const check = (): void => {
    try { checkAccountIdentity(identity); } catch { invalidate(); }
    if (account !== accountScopeIdentity() || enrollment !== enrollmentScopeIdentity() || enrollmentRunning()) invalidate();
    if (!sameDestination(server, base, central)) invalidate();
    if (controller.signal.aborted) throw new Error(MIGRATION_CHANGED);
    if (activeAccount()?.role !== 'admin') throw new ForbiddenError('Only an organization admin can manage a migration.');
  };
  const subscriptions = [subscribeAccountScope(invalidate), subscribeCurrentServer(invalidate), subscribeEnrollmentScope(invalidate)];
  const routeChanged = (): void => { if (base !== daemonBase()) invalidate(); };
  if (typeof window !== 'undefined') window.addEventListener('hashchange', routeChanged);
  return {
    base, owner: identity?.organization ?? null, agentId: server?.id ?? null, signal: controller.signal, check, invalidate,
    dispose: () => {
      controller.abort();
      for (const unsubscribe of subscriptions) unsubscribe();
      if (typeof window !== 'undefined') window.removeEventListener('hashchange', routeChanged);
    },
  };
}
