import type { IncomingMessage, ServerResponse } from 'node:http';
import { errMsg, log } from './log.js';
import { ApiError } from './api-error.js';
import {
  apiFailure,
  bodyField,
  readJsonBody,
  sendJson,
  type ApiSession,
} from './api-http.js';
import {
  isStationName,
  parseAccountId,
  type AccountRef,
} from '../db/account-attach.js';
import type { StationName } from '../db/schema.js';
import {
  ATTACHABLE_STATIONS,
  isAttachStation,
  type AttachInput,
  type OneTimeSecret,
  type PreparedAccount,
} from '../stations/attach.js';

export interface AccountApiDeps {
  prepareAccount: (input: AttachInput) => Promise<PreparedAccount>;
  attachAccount: (
    email: string,
    granted: string[],
    agentId: number,
    station: StationName,
    config: Record<string, unknown>,
  ) => Promise<AccountRef>;
  detachAccount: (
    email: string,
    granted: string[],
    agentId: number,
    station: StationName,
    accountId: string,
  ) => Promise<AccountRef>;
  syncStations: (station: StationName) => Promise<void>;
}

export type AccountRoute =
  | { kind: 'start' }
  | { kind: 'account'; station: StationName; accountId: string };

export const ATTACHABLE: string[] = [...ATTACHABLE_STATIONS];

const ROUTE_METHODS: Record<AccountRoute['kind'], string[]> = {
  start: ['POST'],
  account: ['DELETE'],
};

export function accountRoute(rest: string[]): AccountRoute | null {
  if (rest.length === 1 && rest[0] === 'start') return { kind: 'start' };
  if (rest.length !== 2) return null;
  const [station, raw] = rest;
  if (!isStationName(station) || raw === undefined) return null;
  const accountId = parseAccountId(raw);
  return accountId === null ? null : { kind: 'account', station, accountId };
}

export function accountRouteAllows(
  route: AccountRoute,
  method: string | undefined,
): boolean {
  return ROUTE_METHODS[route.kind].includes(method ?? '');
}

async function activate(
  deps: AccountApiDeps,
  station: StationName,
): Promise<boolean> {
  try {
    await deps.syncStations(station);
    return true;
  } catch (err) {
    log.warn(
      { station, err: errMsg(err) },
      'account-api: station reload failed, the change lands at the next boot',
    );
    return false;
  }
}

interface AttachPayload {
  status: 'done';
  agentId: number;
  station: string;
  accountId: string;
  identity: Record<string, string>;
  activated: boolean;
  secret?: OneTimeSecret;
}

async function handleStart(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AccountApiDeps,
  session: ApiSession,
  agentId: number,
): Promise<void> {
  const body = await readJsonBody(req);
  const station = bodyField(body, 'station');
  if (!isAttachStation(station))
    throw new ApiError(`station must be one of ${ATTACHABLE.join(', ')}`, 400);
  const prepared = await deps.prepareAccount({
    station,
    token: bodyField(body, 'token'),
  });
  const ref = await deps.attachAccount(
    session.email,
    session.granted,
    agentId,
    station,
    prepared.config,
  );
  log.info(
    { agentId: ref.agentId, station, account: ref.accountId },
    'account-api: attached a station account',
  );
  const payload: AttachPayload = {
    status: 'done',
    agentId: ref.agentId,
    station,
    accountId: ref.accountId,
    identity: prepared.identity,
    activated: await activate(deps, station),
  };
  sendJson(
    req,
    res,
    201,
    prepared.secret === undefined
      ? payload
      : { ...payload, secret: prepared.secret },
  );
}

async function handleDetach(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AccountApiDeps,
  session: ApiSession,
  agentId: number,
  target: { station: StationName; accountId: string },
): Promise<void> {
  const ref = await deps.detachAccount(
    session.email,
    session.granted,
    agentId,
    target.station,
    target.accountId,
  );
  log.info(
    { agentId: ref.agentId, station: ref.station, account: ref.accountId },
    'account-api: detached a station account',
  );
  sendJson(req, res, 200, {
    agentId: ref.agentId,
    station: ref.station,
    accountId: ref.accountId,
    detached: true,
    activated: await activate(deps, ref.station),
  });
}

export async function handleAccountRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AccountApiDeps,
  session: ApiSession,
  agentId: number,
  route: AccountRoute,
): Promise<void> {
  try {
    if (route.kind === 'start')
      await handleStart(req, res, deps, session, agentId);
    else await handleDetach(req, res, deps, session, agentId, route);
  } catch (err) {
    apiFailure(req, res, err);
  }
}
