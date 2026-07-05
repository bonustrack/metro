import { forwardTrainCall } from '../daemon/train-call.js';
import { accountStationNames } from '../stations/registry.js';

export async function gatherAccounts(): Promise<Record<string, unknown[]>> {
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
  return out;
}
