import { ipcCall } from '../daemon/ipc.js';
import { accountStationNames } from '../stations/registry.js';

export async function gatherAccounts(): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  await Promise.all(
    accountStationNames().map(async (station) => {
      try {
        const resp = await ipcCall({
          op: 'forward-call',
          train: station,
          action: 'accounts',
          args: {},
        });
        const accounts =
          resp.ok && 'response' in resp
            ? (resp.response.result as { accounts?: unknown[] } | undefined)
                ?.accounts
            : undefined;
        out[station] = Array.isArray(accounts) ? accounts : [];
      } catch {
        out[station] = [];
      }
    }),
  );
  return out;
}
