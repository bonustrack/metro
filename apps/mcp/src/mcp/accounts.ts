import { forwardTrainCall } from '../daemon/train-call.js';
import { accountStationNames } from '../stations/registry.js';
import { agentForAccount } from '../db/agent-map.js';

const accountId = (acc: unknown): string | undefined => {
  const id = (acc as { id?: unknown }).id;
  return typeof id === 'string' ? id : undefined;
};

export function scopeAccountsByAgent(
  byStation: Record<string, unknown[]>,
  allowed: Set<string>,
): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const [station, list] of Object.entries(byStation)) {
    out[station] = list.filter((acc) => {
      const id = accountId(acc);
      if (id === undefined) return false;
      const agent = agentForAccount(station, id);
      return agent !== undefined && allowed.has(agent);
    });
  }
  return out;
}

export async function gatherAccounts(
  allowedAgents?: Set<string>,
): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  await Promise.all(
    accountStationNames().map(async (station) => {
      try {
        const resp = await forwardTrainCall(station, 'accounts', {});
        const accounts = (
          resp.result as { accounts?: unknown[] } | undefined
        )?.accounts;
        out[station] = Array.isArray(accounts) ? accounts : [];
      } catch {
        out[station] = [];
      }
    }),
  );
  return allowedAgents ? scopeAccountsByAgent(out, allowedAgents) : out;
}
