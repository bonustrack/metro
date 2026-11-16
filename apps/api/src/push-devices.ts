import type { IncomingMessage, ServerResponse } from 'node:http';
import { isRecord } from '@metro-labs/core/is-record';
import { log } from '@metro-labs/core/log';
import { ApiError } from '@metro-labs/http/api-error';
import { apiFailure, cors, readJsonBody, sendJson } from '@metro-labs/http/api-http';
import { bearerSession, type Session, type KeySource } from '@metro-labs/http/user-token';
import { failureText } from '@metro-labs/connectors/db/errors';
import type { Database } from './db/client.js';
import { dropPushDevice, EXPO_PUSH_TOKEN_RE, isPushPlatform, registerPushDevice } from './db/push-devices.js';

const PATH = '/api/push/devices';
const BODY_MAX = 4096;

export interface PushDevicesDeps {
  keys: KeySource;
  db: () => Database;
  now: () => number;
}

function tokenOf(body: unknown): string {
  const token = isRecord(body) && typeof body.token === 'string' ? body.token.trim() : '';
  if (!EXPO_PUSH_TOKEN_RE.test(token)) throw new ApiError('token must be an Expo push token', 400);
  return token;
}

async function register(deps: PushDevicesDeps, session: Session, body: unknown): Promise<unknown> {
  const token = tokenOf(body);
  const platform = isRecord(body) ? body.platform : undefined;
  if (!isPushPlatform(platform)) throw new ApiError('platform must be android or ios', 400);
  await registerPushDevice(deps.db(), { user: session.userId, token, platform, now: deps.now() });
  log.info({ user: session.userId, platform }, 'push: device registered');
  return { registered: true };
}

async function unregister(deps: PushDevicesDeps, session: Session, body: unknown): Promise<unknown> {
  const removed = await dropPushDevice(deps.db(), session.userId, tokenOf(body));
  if (removed) log.info({ user: session.userId }, 'push: device removed');
  return { removed };
}

async function answer(req: IncomingMessage, deps: PushDevicesDeps): Promise<unknown> {
  const session = await bearerSession(req, deps.keys);
  if (session === null) throw new ApiError('unauthorized', 401);
  const body = await readJsonBody(req, BODY_MAX);
  try {
    return await (req.method === 'POST' ? register(deps, session, body) : unregister(deps, session, body));
  } catch (err) {
    if (err instanceof ApiError) throw err;
    log.warn({ user: session.userId, err: failureText(err) }, 'push: device not saved');
    throw new ApiError('Metro could not save this device. Try again.', 503);
  }
}

export function handlePushDevicesRequest(req: IncomingMessage, res: ServerResponse, deps: PushDevicesDeps): boolean {
  const path = (req.url ?? '').split('?')[0] ?? '';
  if (path !== PATH && path !== `${PATH}/`) return false;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors(req)).end();
    return true;
  }
  if (req.method !== 'POST' && req.method !== 'DELETE') {
    sendJson(req, res, 405, { error: 'method not allowed' });
    return true;
  }
  answer(req, deps)
    .then((body) => {
      sendJson(req, res, 200, body);
    })
    .catch((err: unknown) => {
      apiFailure(req, res, err, 'push-devices');
    });
  return true;
}
