import {
  accountFromLine,
  agentIdForAccount,
  stationAgentIds,
} from './map.js';
import { STATIONS } from '@metro-labs/core/station-names';

const ACCOUNT_STATIONS = new Set<string>(STATIONS);
const CONNECTOR_LINES_MAX = 500;
const connectorLines = new Map<string, string>();

export function noteConnectorLine(key: string, connectorId: string, agentId: string): void {
  const name = `${key}/${connectorId}`;
  connectorLines.delete(name);
  connectorLines.set(name, agentId);
  for (const oldest of connectorLines.keys()) {
    if (connectorLines.size <= CONNECTOR_LINES_MAX) break;
    connectorLines.delete(oldest);
  }
}

export function forgetConnectorLines(): void {
  connectorLines.clear();
}

function connectorLineAgent(line: string): string | undefined {
  const acct = accountFromLine(line);
  if (!acct || agentIdForAccount(acct.station, acct.accountId) !== undefined) return undefined;
  return connectorLines.get(`${acct.station}/${acct.accountId}`);
}

export const isConnectorLine = (line: string): boolean => connectorLineAgent(line) !== undefined;

export function knownConnectorLines(): { station: string; id: string; agentId: string }[] {
  return [...connectorLines].flatMap(([name, agentId]) => {
    const cut = name.indexOf('/');
    const station = name.slice(0, cut);
    const id = name.slice(cut + 1);
    return agentIdForAccount(station, id) === undefined ? [{ station, id, agentId }] : [];
  });
}

const stationHasAccounts = (station: string): boolean =>
  ACCOUNT_STATIONS.has(station);

const accountInScope = (
  allowed: Set<string>,
  station: string,
  accountId: string,
): boolean => {
  const agentId = agentIdForAccount(station, accountId);
  return agentId !== undefined && allowed.has(agentId);
};

export function lineTargetDenied(
  allowed: Set<string>,
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
  allowed: Set<string>,
  station: string,
): boolean {
  const ids = stationAgentIds(station);
  return ids.length > 0 && ids.every((id) => allowed.has(id));
}

export function callTargetDenied(
  allowed: Set<string>,
  station: string,
  args: Record<string, unknown>,
): boolean {
  if (typeof args.line === 'string')
    return lineTargetDenied(allowed, args, station);
  if (typeof args.account === 'string')
    return !accountInScope(allowed, station, args.account);
  return !stationFullyScoped(allowed, station);
}

export function eventInScope(allowed: Set<string>, line: string): boolean {
  const acct = accountFromLine(line);
  if (!acct) return false;
  const mailAgent = connectorLineAgent(line);
  if (mailAgent !== undefined) return allowed.has(mailAgent);
  if (!stationHasAccounts(acct.station)) return true;
  return accountInScope(allowed, acct.station, acct.accountId);
}
