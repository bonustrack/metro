import type { IncomingMessage, ServerResponse } from 'node:http';
import type { StationName } from '@metro-labs/core/station-names';
import { ApiError } from '@metro-labs/http/api-error';
import { bodyField, readJsonBody, sendJson } from '@metro-labs/http/api-http';
import { stationByName } from '../stations/registry.js';
import type { AccountRoute } from './account-routes.js';
import { handleSenderCards, type SenderCardDeps } from './sender-cards.js';

interface Target {
  station: StationName;
  accountId: string;
}

interface LookupDeps extends SenderCardDeps {
  resolveSender: (station: StationName, accountId: string, query: string) => Promise<unknown>;
}

type Lookup = (req: IncomingMessage, res: ServerResponse, deps: LookupDeps, target: Target) => Promise<void>;

function lookupQuery(req: IncomingMessage): string {
  const params = new URLSearchParams((req.url ?? '').split('?')[1] ?? '');
  return (params.get('q') ?? '').trim();
}

async function handleResolve(req: IncomingMessage, res: ServerResponse, deps: LookupDeps, target: Target): Promise<void> {
  if (stationByName(target.station)?.resolvesSenders !== true)
    throw new ApiError(`metro cannot look a sender up on ${target.station}`, 400);
  const query = lookupQuery(req);
  if (query === '') throw new ApiError('something to look up is required', 400);
  sendJson(req, res, 200, await deps.resolveSender(target.station, target.accountId, query));
}

async function handleName(req: IncomingMessage, res: ServerResponse, deps: LookupDeps, target: Target): Promise<void> {
  if (stationByName(target.station)?.claimsName !== true)
    throw new ApiError(`${target.station} accounts have no name to claim`, 400);
  if (req.method === 'GET') {
    sendJson(req, res, 200, await deps.accountCall(target.station, 'name', { account: target.accountId }));
    return;
  }
  const label = bodyField(await readJsonBody(req), 'label');
  if (typeof label !== 'string' || label.trim() === '') throw new ApiError('a label is required', 400);
  sendJson(req, res, 200, await deps.accountCall(target.station, 'claim_name', { account: target.accountId, label }));
}

function handleRecent(req: IncomingMessage, res: ServerResponse, deps: LookupDeps, target: Target): Promise<void> {
  sendJson(req, res, 200, { senders: deps.recentSenders(target.station, target.accountId) });
  return Promise.resolve();
}

export const LOOKUPS: Partial<Record<AccountRoute['kind'], Lookup>> = {
  profiles: handleSenderCards,
  resolve: handleResolve,
  name: handleName,
  senders: handleRecent,
};
