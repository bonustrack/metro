import {
  accountFromLine,
  agentIdForAccount,
  stationAgentIds,
} from './agent-map.js';

const accountInScope = (
  allowed: Set<number>,
  station: string,
  accountId: string,
): boolean => {
  const agentId = agentIdForAccount(station, accountId);
  return agentId !== undefined && allowed.has(agentId);
};

export function lineTargetDenied(
  allowed: Set<number>,
  args: Record<string, unknown>,
  station?: string,
): boolean {
  const line = typeof args.line === 'string' ? args.line : undefined;
  if (line === undefined) return false;
  const acct = accountFromLine(line);
  if (!acct) return true;
  if (station !== undefined && acct.station !== station) return true;
  if (!accountInScope(allowed, acct.station, acct.accountId)) return true;
  const override = typeof args.account === 'string' ? args.account : undefined;
  return override !== undefined
    ? !accountInScope(allowed, acct.station, override)
    : false;
}

export function stationFullyScoped(
  allowed: Set<number>,
  station: string,
): boolean {
  const ids = stationAgentIds(station);
  return ids.length > 0 && ids.every((id) => allowed.has(id));
}

export function callTargetDenied(
  allowed: Set<number>,
  station: string,
  args: Record<string, unknown>,
): boolean {
  if (typeof args.line === 'string')
    return lineTargetDenied(allowed, args, station);
  if (typeof args.account === 'string')
    return !accountInScope(allowed, station, args.account);
  return !stationFullyScoped(allowed, station);
}

export function eventInScope(allowed: Set<number>, line: string): boolean {
  const acct = accountFromLine(line);
  if (!acct) return true;
  const agentId = agentIdForAccount(acct.station, acct.accountId);
  return agentId === undefined || allowed.has(agentId);
}
