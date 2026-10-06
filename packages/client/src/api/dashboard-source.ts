import { accountScopeIdentity, tokenExpiring } from '../auth/account.js';
import { fetchNoRedirect } from '../platform.js';
import { baseFromSegment, builtInDaemon } from '../auth/daemon.js';
import { accessToken, refreshAccount, scopedOrganizationAccessToken, toOrganizations } from './auth.js';
import { AuthError, callBearer, ForbiddenError, NotFoundError, StoppedError } from './client.js';
import { toMode, type ModeInfo } from './mode.js';
import { olderThan } from './version.js';
import { toRuntimeSnapshot } from './claude-box.js';
import { toModelSettings } from './model.js';
import { dashboardKey, type DashboardRow } from './dashboard.js';
import type { DashboardSource } from './dashboard-poll.js';

const REQUEST_MS = 8_000;
export const DASHBOARD_SINCE = '0.1.0-beta.271';

async function timed<T>(signal: AbortSignal, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  if (signal.aborted) throw new Error('Dashboard request cancelled.');
  const controller = new AbortController();
  const abort = (): void => { controller.abort(); };
  signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, REQUEST_MS);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}

function rowBase(row: DashboardRow): string {
  const { host } = row.agent;
  const url = new URL(baseFromSegment(host));
  if (url.host !== host || url.username !== '' || url.password !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== '')
    throw new Error('Invalid agent address.');
  return url.origin;
}

async function passiveMode(row: DashboardRow, signal: AbortSignal): Promise<ModeInfo> {
  return timed(signal, async (bounded) => {
    const response = await fetchNoRedirect(`${rowBase(row)}/api/mode`, { signal: bounded });
    const mode = toMode(await response.json().catch(() => null));
    if (!response.ok || mode === null) throw new Error('Agent did not answer.');
    return mode;
  });
}

async function inventory(signal: AbortSignal, check: () => void): Promise<ReturnType<typeof toOrganizations>> {
  check();
  const token = await accessToken();
  check();
  if (token === null) throw new AuthError('Sign in again to see your agents.');
  const read = (bearer: string): Promise<unknown> => timed(signal, (bounded) => callBearer({ method: 'GET', base: `${builtInDaemon()}/api/auth/organizations`, signal: bounded, checkAccount: check }, bearer));
  try {
    return toOrganizations(await read(token));
  } catch (error) {
    if (!(error instanceof AuthError) || signal.aborted) throw error;
    check();
    const refreshed = await refreshAccount();
    check();
    if (refreshed === null || tokenExpiring(refreshed.accessToken)) throw error;
    return toOrganizations(await read(refreshed.accessToken));
  }
}

export function dashboardSource(scope: number, alive: () => boolean): DashboardSource {
  const tokens = new Map<string, string>();
  const current = (): boolean => alive() && accountScopeIdentity() === scope;
  const check = (): void => { if (!current()) throw new AuthError('Your account changed.'); };
  const modes = new Map<string, { at: number; value: Promise<ModeInfo> }>();
  const readMode = async (row: DashboardRow, signal: AbortSignal): Promise<ModeInfo> => {
    check();
    let cached = modes.get(row.key);
    if (cached === undefined || Date.now() - cached.at > 20_000) {
      cached = { at: Date.now(), value: passiveMode(row, signal) };
      modes.set(row.key, cached);
    }
    const mode = await cached.value;
    check();
    if (mode.owner !== row.organization.id) throw new ForbiddenError('This agent no longer belongs to this organization.');
    return mode;
  };
  const get = async (row: DashboardRow, token: string, signal: AbortSignal, path: string): Promise<unknown> => {
    const mode = await readMode(row, signal);
    if (mode.stopped) throw new StoppedError('Metro is stopped.');
    if (olderThan(mode.version, DASHBOARD_SINCE)) throw new NotFoundError('Update Metro to see dashboard readings.');
    return timed(signal, (bounded) => callBearer({ base: rowBase(row), path, method: 'GET', signal: bounded, checkAccount: check }, token));
  };
  return {
    current, mode: readMode,
    forgetToken: (organization) => { tokens.delete(organization); },
    organizations: async (signal) => {
      const organizations = await inventory(signal, check);
      const ids = new Set(organizations.map((org) => org.id));
      const keys = new Set(organizations.flatMap((org) => (org.agents ?? []).map((agent) => dashboardKey(org.id, agent))));
      for (const id of tokens.keys()) if (!ids.has(id)) tokens.delete(id);
      for (const key of modes.keys()) if (!keys.has(key)) modes.delete(key);
      return organizations;
    },
    token: async (organization, signal) => {
      check();
      const cached = tokens.get(organization);
      if (cached !== undefined && !tokenExpiring(cached)) return cached;
      const token = await scopedOrganizationAccessToken(organization, { signal });
      check();
      tokens.set(organization, token);
      return token;
    },
    session: async (row, token, signal) => toRuntimeSnapshot(await get(row, token, signal, '/api/claude/session/snapshot')),
    model: async (row, token, signal) => toModelSettings(await get(row, token, signal, '/api/model/snapshot')),
  };
}
