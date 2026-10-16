import type { Vault } from '@metro-labs/client/api/vault';

export function keyLastUsed(vault: Vault, id: string): string | null {
  let latest: string | null = null;
  for (const request of vault.recent) if (request.swapped.includes(id) && (latest === null || request.at > latest)) latest = request.at;
  return latest;
}
