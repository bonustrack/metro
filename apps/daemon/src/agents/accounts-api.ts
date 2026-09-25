import type { IncomingMessage, ServerResponse } from 'node:http';
import { errMsg, log } from '@metro-labs/core/log';
import { normalizeAllowlist, normalizeApprovers } from './allowlist.js';
import { approversForAccount } from './map.js';
import { isRecord } from '@metro-labs/core/is-record';
import type { RecentSender } from './senders.js';
import { ApiError } from '@metro-labs/http/api-error';
import {
  apiFailure,
  bodyField,
  readJsonBody,
  sendJson,
} from '@metro-labs/http/api-http';
import { type AccountRef } from './account-attach.js';
import { type AccountRoute } from './account-routes.js';
import { handlePolicy, type SetPolicy } from './policy-route.js';
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
import type { StepInput } from '../stations/attach-driver.js';
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
    input: StepInput,
  ) => Promise<AttachView>;
  cancel: (owner: AttachOwner, attachId: string) => Promise<void>;
}

export interface AccountApiDeps {
  attachSessions: AttachSessionApi;
  prepareAccount: (input: AttachInput) => Promise<PreparedAccount>;
  attachAccount: (
    agentId: string,
    station: StationName,
    config: Record<string, unknown>,
  ) => Promise<AccountRef>;
  detachAccount: (
    agentId: string,
    station: StationName,
    accountId: string,
  ) => Promise<AccountRef>;
  syncStations: (station: StationName) => Promise<void>;
  reloadAgents: () => Promise<void>;
  setAllowlist: (
    agentId: string,
    station: StationName,
    accountId: string,
    allowlist: string[],
    approvers?: string[],
  ) => Promise<string[]>;
  setPolicy: SetPolicy;
  recentSenders: (station: StationName, accountId: string) => RecentSender[];
  resolveSender: (
    station: StationName,
    accountId: string,
    query: string,
  ) => Promise<unknown>;
  accountCall: (
    station: StationName,
    action: string,
    args: Record<string, unknown>,
  ) => Promise<unknown>;
  setAccountEnabled: (
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

async function handleName(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AccountApiDeps,
  target: { station: StationName; accountId: string },
): Promise<void> {
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
  agentId: string,
  station: StationName,
  prepared: PreparedAccount,
): Promise<AccountRef> {
  try {
    return await deps.attachAccount(
      agentId,
      station,
      prepared.config,
    );
  } catch (err) {
    prepared.discard?.();
    throw err;
  }
}


function asInput(body: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ['apiId', 'apiHash', 'phone', 'mailbox'])
    out[key] = bodyField(body, key);
  return out;
}

async function handleStart(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AccountApiDeps,
  agentId: string,
): Promise<void> {
  const body = await readJsonBody(req);
  const station = bodyField(body, 'station');
  if (isInteractiveStation(station)) {
    const view = await deps.attachSessions.start(
      { agentId },
      station,
      asInput(body),
    );
    sendJson(req, res, 201, view);
    return;
  }
  if (!isAttachStation(station))
    throw new ApiError(`station must be one of ${ATTACHABLE.join(', ')}`, 400);
  const prepared = await deps.prepareAccount(attachInputOf(station, body));
  const ref = await storeAccount(deps, agentId, station, prepared);
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
  agentId: string,
  target: { station: StationName; accountId: string },
): Promise<void> {
  const ref = await deps.detachAccount(
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
  forgetAccount(ref.station, ref.accountId);
}

function forgetAccount(station: StationName, accountId: string): void {
  try {
    stationByName(station)?.forget?.(accountId);
  } catch (err) {
    log.warn(
      { station, account: accountId, err: errMsg(err) },
      'account-api: could not remove the files of a detached account',
    );
  }
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
  agentId: string,
  target: { station: StationName; accountId: string },
): Promise<void> {
  const body = await readJsonBody(req);
  const wanted = normalizeAllowlist(bodyField(body, 'allowlist'));
  const asked = isRecord(body) && 'approvers' in body ? body.approvers : approversForAccount(target.station, target.accountId);
  const approvers = normalizeApprovers(asked, wanted);
  const allowlist = await deps.setAllowlist(agentId, target.station, target.accountId, wanted, approvers);
  log.info({ agentId, station: target.station, account: target.accountId, senders: allowlist.length }, 'account-api: allowlist set');
  sendJson(req, res, 200, {
    agentId,
    station: target.station,
    accountId: target.accountId,
    allowlist,
    approvers,
    activated: await applied(deps),
  });
}

async function handleEnabled(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AccountApiDeps,
  agentId: string,
  target: { station: StationName; accountId: string },
): Promise<void> {
  const wanted = bodyField(await readJsonBody(req), 'enabled');
  if (typeof wanted !== 'boolean') throw new ApiError('enabled must be true or false', 400);
  const enabled = await deps.setAccountEnabled(agentId, target.station, target.accountId, wanted);
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
  const field = (key: string): unknown => bodyField(body, key);
  const view = await deps.attachSessions.submit(owner, attachId, {
    code: field('code'),
    password: field('password'),
    state: field('state'),
    mode: field('mode'),
    error: field('error'),
    errorDescription: field('errorDescription'),
  });
  sendJson(req, res, 200, view);
}

async function dispatchRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AccountApiDeps,
  agentId: string,
  route: AccountRoute,
): Promise<void> {
  if (route.kind === 'start')
    return handleStart(req, res, deps, agentId);
  if (route.kind === 'session')
    return handleSession(
      req,
      res,
      deps,
      { agentId },
      route.attachId,
    );
  if (route.kind === 'step')
    return handleStep(req, res, deps, { agentId }, route.attachId);
  if (route.kind === 'allowlist') return handleAllowlist(req, res, deps, agentId, route);
  if (route.kind === 'enabled') return handleEnabled(req, res, deps, agentId, route);
  if (route.kind === 'policy') return handlePolicy(req, res, deps, agentId, route);
  if (route.kind === 'resolve') return handleResolve(req, res, deps, route);
  if (route.kind === 'name') return handleName(req, res, deps, route);
  if (route.kind === 'senders') {
    sendJson(req, res, 200, { senders: deps.recentSenders(route.station, route.accountId) });
    return;
  }
  return handleDetach(req, res, deps, agentId, route);
}

export async function handleAccountRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AccountApiDeps,
  agentId: string,
  route: AccountRoute,
): Promise<void> {
  try {
    await dispatchRoute(req, res, deps, agentId, route);
  } catch (err) {
    apiFailure(req, res, err);
  }
}
