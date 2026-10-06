import type { IncomingMessage, ServerResponse } from 'node:http';
import { log } from '@metro-labs/core/log';
import { ApiError } from '@metro-labs/http/api-error';
import { cors, readJsonBody, sendJson } from '@metro-labs/http/api-http';
import { bearerSession, isOrganizationId, type Session, type SigningKeys } from '@metro-labs/http/workos-token';
import type { GmailBroker, GmailSession } from './broker.js';
import { GmailError } from './input.js';

export interface GmailApiDeps {
  broker: GmailBroker;
  keys: SigningKeys;
}

const PREFIX = '/api/gmail';
const POSTS = ['start', 'exchange', 'refresh', 'revoke', 'cancel'];
const BODY_MAX = 24 * 1024;

function withOrganization(session: Session): GmailSession {
  if (session.organization === null || !isOrganizationId(session.organization)) throw new GmailError('Sign in to an organization to connect Gmail.', 401);
  return { ...session, organization: session.organization };
}

async function bodyOf(req: IncomingMessage): Promise<unknown> {
  try {
    return await readJsonBody(req, BODY_MAX);
  } catch (err) {
    if (err instanceof ApiError) throw new GmailError(err.message, err.status);
    throw new GmailError('The Gmail request could not be read.', 400);
  }
}

function refuseBrowserCredentials(req: IncomingMessage): void {
  const browser = Object.keys(req.headers).some((name) => name === 'origin' || name.startsWith('sec-fetch-'));
  if (req.method === 'POST' && browser) throw new GmailError('Connect Gmail through your Metro server, not directly from a browser.', 403);
}

async function answer(req: IncomingMessage, deps: GmailApiDeps, action: string): Promise<unknown> {
  refuseBrowserCredentials(req);
  if (action === 'refresh') return deps.broker.refresh(await bodyOf(req));
  if (action === 'revoke') return deps.broker.revoke(await bodyOf(req));
  const session = await bearerSession(req, deps.keys);
  if (session === null) throw new GmailError('Sign in to connect Gmail.', 401);
  if (action === '') return { available: deps.broker.available() };
  const actor = withOrganization(session);
  const body = await bodyOf(req);
  if (action === 'start') return deps.broker.start(actor, body);
  if (action === 'exchange') return deps.broker.exchange(actor, body);
  return deps.broker.cancel(actor, body);
}

function failed(req: IncomingMessage, res: ServerResponse, err: unknown): void {
  if (res.headersSent) return;
  if (err instanceof GmailError) {
    sendJson(req, res, err.status, { error: err.message });
    return;
  }
  log.warn('gmail-api: request failed');
  sendJson(req, res, 503, { error: 'Managed Gmail sign-in is unavailable. Try again.' });
}

export function handleGmailApiRequest(req: IncomingMessage, res: ServerResponse, deps: GmailApiDeps): boolean {
  const path = (req.url ?? '').split('?')[0] ?? '';
  if (path !== PREFIX && !path.startsWith(`${PREFIX}/`)) return false;
  const action = path.slice(PREFIX.length + 1);
  if (action !== '' && !POSTS.includes(action)) {
    sendJson(req, res, 404, { error: 'No such Gmail route.' });
    return true;
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { ...cors(req), 'cache-control': 'no-store' }).end();
    return true;
  }
  const method = action === '' ? 'GET' : 'POST';
  if (req.method !== method) {
    res.setHeader('allow', `${method}, OPTIONS`);
    sendJson(req, res, 405, { error: 'Method not allowed.' });
    return true;
  }
  answer(req, deps, action).then((body) => {
    sendJson(req, res, 200, body);
  }).catch((err: unknown) => {
    failed(req, res, err);
  });
  return true;
}
