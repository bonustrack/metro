import { forwardTrainCall } from '../daemon/train-call.js';
import {
  accountStationNames,
  stationByName,
} from '../stations/registry.js';
import { listEndpoints } from '../daemon/tunnel.js';
import { hookUrl } from '../stations/attach.js';
import { agentIdForAccount } from '../db/agent-map.js';

const accountId = (acc: unknown): string | undefined => {
  const id = (acc as { id?: unknown }).id;
  return typeof id === 'string' ? id : undefined;
};

const asRecord = (acc: unknown): Record<string, unknown> | undefined =>
  typeof acc === 'object' && acc !== null && !Array.isArray(acc)
    ? (acc as Record<string, unknown>)
    : undefined;

function withAgentId(station: string, acc: unknown): unknown {
  const rec = asRecord(acc);
  if (rec === undefined) return acc;
  const id = typeof rec.id === 'string' ? rec.id : undefined;
  if (id === undefined) return acc;
  const agentId = agentIdForAccount(station, id);
  return agentId === undefined ? acc : { ...rec, agentId };
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
  allowed: Set<number>,
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

export interface ScopedAccounts {
  accounts: Record<string, unknown[]>;
  unavailable: string[];
}

async function loadStations(): Promise<ScopedAccounts> {
  const unavailable: string[] = [];
  const accounts: Record<string, unknown[]> = {};
  await Promise.all(
    accountStationNames().map(async (station) => {
      if (!hasTrain(station)) {
        accounts[station] = inCoreAccounts(station);
        return;
      }
      try {
        const resp = await forwardTrainCall(station, 'accounts', {});
        const list = (resp.result as { accounts?: unknown[] } | undefined)
          ?.accounts;
        accounts[station] = Array.isArray(list) ? list : [];
      } catch {
        accounts[station] = [];
        unavailable.push(station);
      }
    }),
  );
  return { accounts, unavailable };
}

export async function gatherAccounts(
  allowedAgents?: Set<number>,
): Promise<Record<string, unknown[]>> {
  const { accounts } = await loadStations();
  return allowedAgents ? scopeAccountsByAgent(accounts, allowedAgents) : accounts;
}

export async function gatherAccountsForAgents(
  allowed: Set<number>,
): Promise<ScopedAccounts> {
  const { accounts, unavailable } = await loadStations();
  return {
    accounts: attachAgentIds(scopeAccountsByAgent(accounts, allowed)),
    unavailable,
  };
}
