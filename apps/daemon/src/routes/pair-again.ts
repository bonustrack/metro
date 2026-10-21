import { ApiError } from '@metro-labs/http/api-error';
import type { StationName } from '@metro-labs/core/station-names';
import { localPairAgain, readLocalAgentFile } from '../agents/file-admin.js';
import type { AccountRef } from '../agents/account-attach.js';
import { stationByName } from '../stations/registry.js';
import type { AttachOwner } from '../stations/attach-session.js';

function identityOf(station: string): string {
  const identity = stationByName(station)?.pairAgain?.identity;
  if (identity === undefined) throw new ApiError(`${station} cannot pair again`, 400);
  return identity;
}

export function pairAgainInput(owner: AttachOwner, station: string, accountId: string, input: Record<string, unknown>): Record<string, unknown> {
  const identity = identityOf(station);
  const account = readLocalAgentFile(owner.agentId).stations.find((s) => s.station === station && s.id === accountId);
  if (account === undefined) throw new ApiError('No such channel on this agent.', 404);
  return { ...input, expect: account.config[identity] };
}

export function finishPairAgain(owner: AttachOwner, station: StationName, accountId: string, config: Record<string, unknown>): AccountRef {
  return localPairAgain(owner.agentId, station, accountId, identityOf(station), config);
}
