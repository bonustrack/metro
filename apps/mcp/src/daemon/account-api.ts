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
import {
  INTERACTIVE_STATIONS,
  isInteractiveStation,
  type InteractiveStation,
} from '../stations/attach-interactive.js';
import {
  ATTACH_ID_RE,
  type AttachOwner,
  type AttachView,
} from './attach-session.js';

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
  | { kind: 'session'; attachId: string }
  | { kind: 'step'; attachId: string }
  | { kind: 'account'; station: StationName; accountId: string };

export const ATTACHABLE: string[] = [
  ...ATTACHABLE_STATIONS,
  ...INTERACTIVE_STATIONS,
];

const ROUTE_METHODS: Record<AccountRoute['kind'], string[]> = {
  start: ['POST'],
  session: ['GET', 'DELETE'],
  step: ['POST'],
  account: ['DELETE'],
};

function twoSegmentRoute(head: string, tail: string): AccountRoute | null {
  if (ATTACH_ID_RE.test(head))
    return tail === 'step' ? { kind: 'step', attachId: head } : null;
  if (!isStationName(head)) return null;
  const accountId = parseAccountId(tail);
  return accountId === null ? null : { kind: 'account', station: head, accountId };
}

export function accountRoute(rest: string[]): AccountRoute | null {
  const [head, tail] = rest;
  if (head === undefined) return null;
  if (rest.length === 1)
    return head === 'start'
      ? { kind: 'start' }
      : ATTACH_ID_RE.test(head)
        ? { kind: 'session', attachId: head }
        : null;
  if (rest.length !== 2 || tail === undefined) return null;
  return twoSegmentRoute(head, tail);
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

async function storeAccount(
  deps: AccountApiDeps,
  session: ApiSession,
  agentId: number,
  station: StationName,
  prepared: PreparedAccount,
): Promise<AccountRef> {
  try {
    return await deps.attachAccount(
      session.email,
      session.granted,
      agentId,
      station,
      prepared.config,
    );
  } catch (err) {
    prepared.discard?.();
    throw err;
  }
}

function ownerOf(session: ApiSession, agentId: number): AttachOwner {
  return { email: session.email, granted: session.granted, agentId };
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
  agentId: number,
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
  const prepared = await deps.prepareAccount({
    station,
    token: bodyField(body, 'token'),
  });
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
  agentId: number,
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
  return handleDetach(req, res, deps, session, agentId, route);
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
    await dispatchRoute(req, res, deps, session, agentId, route);
  } catch (err) {
    apiFailure(req, res, err);
  }
}
