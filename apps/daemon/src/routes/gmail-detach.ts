import { ApiError } from '@metro-labs/http/api-error';
import { localDetachAccount, localOwner, readLocalAgentFile } from '../agents/file-admin.js';
import { forwardTrainCall } from '../stations/train-call.js';

const deleting = new Set<string>();
const keyOf = (agentId: string, accountId: string): string => `${agentId}/${accountId}`;

export function assertGmailNotDeleting(agentId: string, accountId: string): void {
  if (deleting.has(keyOf(agentId, accountId))) throw new ApiError('This Gmail connection is being deleted. Try again after it finishes.', 409);
}

async function revokeConnection(accountId: string, authorizationId: unknown): Promise<void> {
  try {
    const response = await forwardTrainCall('gmail', 'disconnect', { account: accountId, authorizationId });
    const result = response.result as { revoked?: unknown } | undefined;
    if (response.error !== undefined || result?.revoked !== true) throw new Error('revocation not confirmed');
  } catch {
    throw new ApiError('Google access could not be revoked. The Gmail channel was kept. Keep the Gmail service running and try deleting again.', 503);
  }
}

export const detachWithGmailRevocation: typeof localDetachAccount = async (agentId, station, accountId, dir) => {
  const config = station === 'gmail' ? readLocalAgentFile(agentId, dir).stations.find((a) => a.station === station && a.id === accountId)?.config : undefined;
  if (config?.managed !== true) return localDetachAccount(agentId, station, accountId, dir);
  assertGmailNotDeleting(agentId, accountId);
  const key = keyOf(agentId, accountId);
  const owner = localOwner(dir);
  deleting.add(key);
  try {
    await revokeConnection(accountId, config.authorizationId);
    const current = readLocalAgentFile(agentId, dir).stations.find((a) => a.station === station && a.id === accountId)?.config;
    if (localOwner(dir) !== owner || current?.authorizationId !== config.authorizationId) throw new ApiError('This box or Gmail connection changed during deletion. Google access was revoked; review the connection before trying again.', 409);
    return await localDetachAccount(agentId, station, accountId, dir);
  } finally {
    deleting.delete(key);
  }
};
