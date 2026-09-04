import type { IncomingMessage, ServerResponse } from 'node:http';
import { log } from './log.js';
import {
  apiFailure,
  bodyField,
  cors,
  readJsonBody,
  sendJson,
} from './api-http.js';
import { mintNonce, takeNonce } from './siwe-nonces.js';
import { verifySiweLogin } from './siwe-auth.js';
import { signSession } from './session.js';
import { SESSION_TTL_SEC } from './session-config.js';
import { ensureUserByAddress } from '../db/users.js';

const NONCE_PATH = '/auth/siwe/nonce';
const VERIFY_PATH = '/auth/siwe/verify';

export interface SiweRouteDeps {
  ensureUser: (address: string) => Promise<string>;
}

const defaultDeps: SiweRouteDeps = { ensureUser: ensureUserByAddress };

async function handleVerify(
  req: IncomingMessage,
  res: ServerResponse,
  secret: string,
  deps: SiweRouteDeps,
): Promise<void> {
  const body = await readJsonBody(req);
  const message = bodyField(body, 'message');
  const signature = bodyField(body, 'signature');
  if (typeof message !== 'string' || typeof signature !== 'string') {
    sendJson(req, res, 400, { error: 'message and signature are required' });
    return;
  }
  const address = await verifySiweLogin({ message, signature }, { takeNonce });
  const userId = await deps.ensureUser(address);
  log.info({ userId, address }, 'siwe: session issued');
  const session = signSession({ subject: address, agentIds: [] }, secret, {
    ttlSec: SESSION_TTL_SEC,
  });
  sendJson(req, res, 200, { session, address });
}

const ROUTES: Record<string, string> = {
  [NONCE_PATH]: 'GET',
  [VERIFY_PATH]: 'POST',
};

function refused(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
): boolean {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors(req)).end();
    return true;
  }
  if (req.method !== ROUTES[path]) {
    sendJson(req, res, 405, { error: 'method not allowed' });
    return true;
  }
  return false;
}

export function handleSiweAuthRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: SiweRouteDeps = defaultDeps,
): boolean {
  const path = (req.url ?? '').split('?')[0] ?? '';
  if (ROUTES[path] === undefined) return false;
  if (refused(req, res, path)) return true;
  const secret = process.env.METRO_SESSION_SECRET?.trim() ?? '';
  if (secret === '') {
    sendJson(req, res, 503, { error: 'sign-in is not configured' });
    return true;
  }
  if (path === NONCE_PATH) {
    sendJson(req, res, 200, { nonce: mintNonce() });
    return true;
  }
  handleVerify(req, res, secret, deps).catch((err: unknown) => {
    apiFailure(req, res, err, 'siwe');
  });
  return true;
}
