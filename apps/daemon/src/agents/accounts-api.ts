import type { IncomingMessage, ServerResponse } from 'node:http';
import { errMsg, log } from '@metro-labs/core/log';
import { normalizeAllowlist } from './allowlist.js';
import type { RecentSender } from './senders.js';
import { ApiError } from '@metro-labs/http/api-error';
import {
  apiFailure,
  bodyField,
  readJsonBody,
  sendJson,
  type ApiSession,
} from '@metro-labs/http/api-http';
import { type AccountRef } from './account-attach.js';
import { type AccountRoute } from './account-routes.js';
import { stationByName } from '../stations/registry.js';
import type { StationName } from '@metro-labs/core/station-names';
import {
  ATTACHABLE_STATIONS,
  attachInputOf,
  isAttachStation,
  type AttachInput,
  type OneTimeSecret,
  type PreparedAccount,
} from '../stations/attach.js';
import {
  INTERACTIVE_STATIONS,
  isInteractiveStation,
  type InteractiveStation,
} from '../stations/attach-interactive.js';
import {
  type AttachOwner,
  type AttachView,
} from '../stations/attach-session.js';

export interface AttachSessionApi {
  start: (
    owner: AttachOwner,
    station: InteractiveStation,
    input: Record<string, unknown>,
  ) => Promise<AttachView>;
  view: (owner: AttachOwner, attachId: string) => AttachView;
  submit: (
    owner: AttachOwner,
    attachId: string,
    input: { code?: unknown; password?: unknown },
  ) => Promise<AttachView>;
  cancel: (owner: AttachOwner, attachId: string) => Promise<void>;
}

export interface AccountApiDeps {
  attachSessions: AttachSessionApi;
  prepareAccount: (input: AttachInput) => Promise<PreparedAccount>;
  attachAccount: (
    subject: string,
    agentId: string,
    station: StationName,
    config: Record<string, unknown>,
  ) => Promise<AccountRef>;
  detachAccount: (
    subject: string,
    agentId: string,
    station: StationName,
    accountId: string,
  ) => Promise<AccountRef>;
  syncStations: (station: StationName) => Promise<void>;
  reloadAgents: () => Promise<void>;
  setAllowlist: (
    subject: string,
    agentId: string,
    station: StationName,
    accountId: string,
    allowlist: string[],
  ) => Promise<string[]>;
  recentSenders: (station: StationName, accountId: string) => RecentSender[];
  resolveSender: (
    station: StationName,
    accountId: string,
    query: string,
  ) => Promise<unknown>;
  setAccountEnabled: (
    subject: string,
    agentId: string,
    station: StationName,
    accountId: string,
    enabled: boolean,
  ) => Promise<boolean>;
}

export const ATTACHABLE: string[] = [
  ...ATTACHABLE_STATIONS,
  ...INTERACTIVE_STATIONS,
];

function lookupQuery(req: IncomingMessage): string {
  const params = new URLSearchParams((req.url ?? '').split('?')[1] ?? '');
  return (params.get('q') ?? '').trim();
}

async function handleResolve(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AccountApiDeps,
  target: { station: StationName; accountId: string },
): Promise<void> {
  if (stationByName(target.station)?.resolvesSenders !== true)
    throw new ApiError(`metro cannot look a sender up on ${target.station}`, 400);
  const query = lookupQuery(req);
  if (query === '') throw new ApiError('a number to look up is required', 400);
  const found = await deps.resolveSender(target.station, target.accountId, query);
  sendJson(req, res, 200, found);
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
  agentId: string;
  station: string;
  accountId: string;
  identity: Record<string, string>;
  activated: boolean;
  secret?: OneTimeSecret;
}

async function storeAccount(
  deps: AccountApiDeps,
  session: ApiSession,
  agentId: string,
  station: StationName,
  prepared: PreparedAccount,
): Promise<AccountRef> {
  try {
    return await deps.attachAccount(
      session.subject,
      agentId,
      station,
      prepared.config,
    );
  } catch (err) {
    prepared.discard?.();
    throw err;
  }
}

function ownerOf(session: ApiSession, agentId: string): AttachOwner {
  return { subject: session.subject, agentId };
}

function asInput(body: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ['apiId', 'apiHash', 'phone'])
    out[key] = bodyField(body, key);
  return out;
}

async function handleStart(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AccountApiDeps,
  session: ApiSession,
  agentId: string,
): Promise<void> {
  const body = await readJsonBody(req);
  const station = bodyField(body, 'station');
  if (isInteractiveStation(station)) {
    const view = await deps.attachSessions.start(
      ownerOf(session, agentId),
      station,
      asInput(body),
    );
    sendJson(req, res, 201, view);
    return;
  }
  if (!isAttachStation(station))
    throw new ApiError(`station must be one of ${ATTACHABLE.join(', ')}`, 400);
  const prepared = await deps.prepareAccount(attachInputOf(station, body));
  const ref = await storeAccount(deps, session, agentId, station, prepared);
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
  agentId: string,
  target: { station: StationName; accountId: string },
): Promise<void> {
  const ref = await deps.detachAccount(
    session.subject,
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

async function applied(deps: AccountApiDeps): Promise<boolean> {
  try {
    await deps.reloadAgents();
    return true;
  } catch (err) {
    log.warn({ err: errMsg(err) }, 'account-api: allowlist reload failed, the change lands at the next boot');
    return false;
  }
}

async function handleAllowlist(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AccountApiDeps,
  session: ApiSession,
  agentId: string,
  target: { station: StationName; accountId: string },
): Promise<void> {
  const wanted = normalizeAllowlist(bodyField(await readJsonBody(req), 'allowlist'));
  const allowlist = await deps.setAllowlist(session.subject, agentId, target.station, target.accountId, wanted);
  log.info({ agentId, station: target.station, account: target.accountId, senders: allowlist.length }, 'account-api: allowlist set');
  sendJson(req, res, 200, {
    agentId,
    station: target.station,
    accountId: target.accountId,
    allowlist,
    activated: await applied(deps),
  });
}

async function handleEnabled(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AccountApiDeps,
  session: ApiSession,
  agentId: string,
  target: { station: StationName; accountId: string },
): Promise<void> {
  const wanted = bodyField(await readJsonBody(req), 'enabled');
  if (typeof wanted !== 'boolean') throw new ApiError('enabled must be true or false', 400);
  const enabled = await deps.setAccountEnabled(session.subject, agentId, target.station, target.accountId, wanted);
  log.info({ agentId, station: target.station, account: target.accountId, enabled }, 'account-api: account enabled flag set');
  sendJson(req, res, 200, {
    agentId,
    station: target.station,
    accountId: target.accountId,
    enabled,
    activated: await activate(deps, target.station),
  });
}

async function handleSession(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AccountApiDeps,
  owner: AttachOwner,
  attachId: string,
): Promise<void> {
  if (req.method === 'DELETE') {
    await deps.attachSessions.cancel(owner, attachId);
    sendJson(req, res, 200, { attachId, cancelled: true });
    return;
  }
  sendJson(req, res, 200, deps.attachSessions.view(owner, attachId));
}

async function handleStep(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AccountApiDeps,
  owner: AttachOwner,
  attachId: string,
): Promise<void> {
  const body = await readJsonBody(req);
  const view = await deps.attachSessions.submit(owner, attachId, {
    code: bodyField(body, 'code'),
    password: bodyField(body, 'password'),
  });
  sendJson(req, res, 200, view);
}

async function dispatchRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AccountApiDeps,
  session: ApiSession,
  agentId: string,
  route: AccountRoute,
): Promise<void> {
  if (route.kind === 'start')
    return handleStart(req, res, deps, session, agentId);
  if (route.kind === 'session')
    return handleSession(
      req,
      res,
      deps,
      ownerOf(session, agentId),
      route.attachId,
    );
  if (route.kind === 'step')
    return handleStep(req, res, deps, ownerOf(session, agentId), route.attachId);
  if (route.kind === 'allowlist') return handleAllowlist(req, res, deps, session, agentId, route);
  if (route.kind === 'enabled') return handleEnabled(req, res, deps, session, agentId, route);
  if (route.kind === 'resolve') return handleResolve(req, res, deps, route);
  if (route.kind === 'senders') {
    sendJson(req, res, 200, { senders: deps.recentSenders(route.station, route.accountId) });
    return;
  }
  return handleDetach(req, res, deps, session, agentId, route);
}

export async function handleAccountRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AccountApiDeps,
  session: ApiSession,
  agentId: string,
  route: AccountRoute,
): Promise<void> {
  try {
    await dispatchRoute(req, res, deps, session, agentId, route);
  } catch (err) {
    apiFailure(req, res, err);
  }
}
