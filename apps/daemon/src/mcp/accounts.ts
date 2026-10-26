import { storedPolicy } from '../policy/policy.js';
import { forwardTrainCall } from '../stations/train-call.js';
import {
  accountStationNames,
  stationByName,
} from '../stations/registry.js';
import { listEndpoints } from '../stations/webhook-endpoints.js';
import { hookUrl, threemaCallbackUrl } from '../stations/attach.js';
import { accountStatusOf } from '@metro-labs/core/stations/account-status';
import { isRecord } from '@metro-labs/core/is-record';
import { accountEnabled, agentIdForAccount, allowlistForAccount, approversForAccount, knownAccounts, type KnownAccount } from '../agents/map.js';

const accountId = (acc: unknown): string | undefined => {
  const id = (acc as { id?: unknown }).id;
  return typeof id === 'string' ? id : undefined;
};

function withAgentId(station: string, acc: unknown): unknown {
  if (!isRecord(acc) || typeof acc.id !== 'string') return acc;
  const id = acc.id;
  const agentId = agentIdForAccount(station, id);
  if (agentId === undefined) return acc;
  const allowlist = allowlistForAccount(station, id);
  const stored = storedPolicy({ kind: 'channel', station, account: id });
  const policy = stored === undefined ? {} : { policy: stored };
  const approvers = approversForAccount(station, id);
  const extra = approvers.length === 0 ? policy : { ...policy, approvers };
  const tagged = allowlist === undefined ? { ...acc, agentId, ...extra } : { ...acc, agentId, allowlist, ...extra };
  return accountEnabled(station, id) ? tagged : { ...tagged, enabled: false };
}

export function attachAgentIds(
  byStation: Record<string, unknown[]>,
): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const [station, list] of Object.entries(byStation))
    out[station] = list.map((acc) => withAgentId(station, acc));
  return out;
}

export function scopeAccountsByAgent(
  byStation: Record<string, unknown[]>,
  allowed: Set<string>,
): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const [station, list] of Object.entries(byStation)) {
    out[station] = list.filter((acc) => {
      const id = accountId(acc);
      if (id === undefined) return false;
      const agentId = agentIdForAccount(station, id);
      return agentId !== undefined && allowed.has(agentId);
    });
  }
  return out;
}

const hasTrain = (station: string): boolean =>
  stationByName(station)?.hasTrain !== false;

function inCoreAccounts(station: string): unknown[] {
  if (station !== 'webhook') return [];
  return listEndpoints().flatMap((e) =>
    e.secret === undefined || e.webhookId === undefined
      ? []
      : [
          {
            id: e.id,
            handle: `/api/webhooks/${e.webhookId}`,
            endpoint: hookUrl(e.webhookId, e.secret),
          },
        ],
  );
}

function withCallbackUrl(acc: unknown): unknown {
  if (!isRecord(acc)) return acc;
  const { callbackId, callbackToken, ...rest } = acc;
  if (typeof callbackId !== 'string' || typeof callbackToken !== 'string') return rest;
  return { ...rest, callback: threemaCallbackUrl(callbackId, callbackToken) };
}

function withStatus(reports: boolean, acc: unknown): unknown {
  if (!isRecord(acc) || !('status' in acc)) return acc;
  const { status, ...rest } = acc;
  const live = reports ? accountStatusOf(status) : null;
  return live === null ? rest : { ...rest, status: live };
}

function decorate(station: string, rows: unknown[]): unknown[] {
  const reports = stationByName(station)?.reportsStatus === true;
  const live = rows.map((row) => withStatus(reports, row));
  return station === 'threema' ? live.map(withCallbackUrl) : live;
}

const STATUS_WAIT_MS = 5_000;

function answerIn<T>(call: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`no answer within ${String(ms)} ms`));
    }, ms);
  });
  return Promise.race([call, late]).finally(() => {
    clearTimeout(timer);
  });
}

export interface ScopedAccounts {
  accounts: Record<string, unknown[]>;
  unavailable: string[];
}

async function liveAccounts(
  station: string,
): Promise<{ rows: unknown[]; reachable: boolean }> {
  if (!hasTrain(station))
    return { rows: inCoreAccounts(station), reachable: true };
  try {
    const call = forwardTrainCall(station, 'accounts', {});
    const resp = await (stationByName(station)?.reportsStatus === true ? answerIn(call, STATUS_WAIT_MS) : call);
    const list = (resp.result as { accounts?: unknown[] } | undefined)?.accounts;
    return { rows: decorate(station, Array.isArray(list) ? list : []), reachable: true };
  } catch {
    return { rows: [], reachable: false };
  }
}

function mergeKnown(
  station: string,
  live: unknown[],
  known: KnownAccount[],
): unknown[] {
  const seen = new Set(
    live.flatMap((row) => {
      const id = accountId(row);
      return id === undefined ? [] : [id];
    }),
  );
  const missing = known
    .filter((r) => r.station === station && !seen.has(r.id))
    .map((r) => ({ id: r.id }));
  return [...live, ...missing];
}

async function loadStations(): Promise<ScopedAccounts> {
  const unavailable: string[] = [];
  const accounts: Record<string, unknown[]> = {};
  const known = knownAccounts();
  await Promise.all(
    accountStationNames().map(async (station) => {
      const { rows, reachable } = await liveAccounts(station);
      if (!reachable) unavailable.push(station);
      accounts[station] = hasTrain(station) ? mergeKnown(station, rows, known) : rows;
    }),
  );
  return { accounts, unavailable };
}

const URL_SECRETS = new Set(['endpoint', 'callback']);

function withoutUrlSecrets(acc: unknown): unknown {
  if (!isRecord(acc)) return acc;
  return Object.fromEntries(Object.entries(acc).filter(([key]) => !URL_SECRETS.has(key)));
}

export async function gatherAccounts(
  allowedAgents?: Set<string>,
): Promise<Record<string, unknown[]>> {
  const { accounts } = await loadStations();
  const scoped = allowedAgents ? scopeAccountsByAgent(accounts, allowedAgents) : accounts;
  return Object.fromEntries(Object.entries(scoped).map(([station, rows]) => [station, rows.map(withoutUrlSecrets)]));
}

export async function gatherAccountsForAgents(
  allowed: Set<string>,
): Promise<ScopedAccounts> {
  const { accounts, unavailable } = await loadStations();
  return {
    accounts: attachAgentIds(scopeAccountsByAgent(accounts, allowed)),
    unavailable,
  };
}
