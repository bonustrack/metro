import { useSyncExternalStore } from 'react';
import { accountScopeIdentity, subscribeAccountScope } from '@metro-labs/client/auth/account';
import { DashboardPoll, initialDashboard } from '@metro-labs/client/api/dashboard-poll';
import { dashboardSource } from '@metro-labs/client/api/dashboard-source';
import type { DashboardState } from '@metro-labs/client/api/dashboard';

const LINGER_MS = 5_000;
const IDLE: DashboardState = initialDashboard();

interface Running {
  scope: number;
  state: DashboardState;
  stop: () => void;
}

const listeners = new Set<() => void>();
let running: Running | null = null;
let linger: ReturnType<typeof setTimeout> | null = null;
let leaveScope: (() => void) | null = null;

const emit = (): void => {
  for (const listener of listeners) listener();
};

function start(scope: number): void {
  let alive = true;
  const own: Running = { scope, state: IDLE, stop: () => undefined };
  const poll = new DashboardPoll(dashboardSource(scope, () => alive), (state) => {
    if (running !== own) return;
    own.state = state;
    emit();
  });
  own.stop = () => {
    alive = false;
    poll.stop();
  };
  running = own;
  poll.start();
}

function stopRunning(): void {
  running?.stop();
  running = null;
}

function follow(): void {
  const scope = accountScopeIdentity();
  if (running?.scope === scope) return;
  stopRunning();
  start(scope);
  emit();
}

function retain(listener: () => void): () => void {
  listeners.add(listener);
  if (linger !== null) clearTimeout(linger);
  linger = null;
  leaveScope ??= subscribeAccountScope(follow);
  follow();
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    linger = setTimeout(() => {
      linger = null;
      if (listeners.size > 0) return;
      leaveScope?.();
      leaveScope = null;
      stopRunning();
    }, LINGER_MS);
  };
}

function snapshot(): DashboardState {
  return running !== null && running.scope === accountScopeIdentity() ? running.state : IDLE;
}

export function useAllAgents(): DashboardState {
  return useSyncExternalStore(retain, snapshot, snapshot);
}
