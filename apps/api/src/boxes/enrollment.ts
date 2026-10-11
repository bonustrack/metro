import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseId } from '@metro-labs/core/ids';
import { isRecord } from '@metro-labs/core/is-record';
import { log } from '@metro-labs/core/log';
import { ApiError } from '@metro-labs/http/api-error';
import { apiFailure, cors, readBodyBytes, sendJson } from '@metro-labs/http/api-http';
import { sealingKeyOf, signingKeyOf } from '@metro-labs/http/box-signature';
import { bearerSession, isOrganizationId, type SigningKeys } from '@metro-labs/http/workos-token';
import type { BoxKeyStore } from '../db/boxes.js';
import { notEnrolled, refuseBrowser, type BoxAuth } from './auth.js';
import type { EnrollTickets } from './tickets.js';

const MINT_RE = /^\/api\/servers\/([^/]+)\/enrollment$/;
const ENROLL = '/api/boxes/enroll';
const SESSION = '/api/boxes/session';
const BODY_MAX = 4096;
const TICKET_RE = /^[A-Za-z0-9_-]{43}$/;
const FIELDS = ['ticket', 'organization', 'signingKey', 'sealingKey'];

export interface EnrollmentDeps {
  enabled: () => boolean;
  keys: SigningKeys;
  tickets: EnrollTickets;
  store: BoxKeyStore;
  auth: BoxAuth;
  now: () => number;
}

interface EnrollInput {
  ticket: string;
  organization: string;
  signingKey: string;
  sealingKey: string;
}

const staleTicket = (): ApiError => new ApiError('This enrollment ticket is stale or belongs to another organization. Start again from the agent page.', 400);

async function mint(req: IncomingMessage, deps: EnrollmentDeps, rawId: string): Promise<unknown> {
  const session = await bearerSession(req, deps.keys);
  const owner = session?.organization ?? null;
  if (session === null || owner === null || !isOrganizationId(owner)) throw new ApiError('unauthorized', 401);
  if (session.role !== 'admin') throw new ApiError('this needs the admin role in your organization', 403);
  const agent = parseId(rawId);
  if (agent === null || !(await deps.store.listed(owner, agent))) throw new ApiError('no such server', 404);
  const minted = deps.tickets.mint({ owner, agent, userId: session.userId }, deps.now());
  log.info({ owner, agent, by: session.userId }, 'boxes: an admin asked to enroll a box');
  return minted;
}

function bodyOf(bytes: Buffer): Record<string, unknown> {
  let body: unknown;
  try {
    body = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new ApiError('body must be JSON', 400);
  }
  if (!isRecord(body) || Object.keys(body).some((key) => !FIELDS.includes(key))) throw new ApiError('Invalid enrollment request.', 400);
  return body;
}

function textOf(value: unknown, valid: (text: string) => boolean, refusal: () => ApiError): string {
  if (typeof value !== 'string' || !valid(value)) throw refusal();
  return value;
}

function enrollInput(bytes: Buffer): EnrollInput {
  const body = bodyOf(bytes);
  return {
    ticket: textOf(body.ticket, (text) => TICKET_RE.test(text), staleTicket),
    organization: textOf(body.organization, isOrganizationId, () => new ApiError('Invalid enrollment request.', 400)),
    signingKey: textOf(body.signingKey, (text) => signingKeyOf(text) !== null, () => new ApiError('Invalid box signing key.', 400)),
    sealingKey: textOf(body.sealingKey, (text) => sealingKeyOf(text) !== null, () => new ApiError('Invalid box sealing key.', 400)),
  };
}

async function enroll(req: IncomingMessage, deps: EnrollmentDeps): Promise<unknown> {
  refuseBrowser(req);
  const bytes = await readBodyBytes(req, BODY_MAX);
  const input = enrollInput(bytes);
  const proof = deps.auth.proofOf(req);
  const now = deps.now();
  const ticket = deps.tickets.peek(input.ticket, now);
  if (ticket?.owner !== input.organization) throw staleTicket();
  deps.auth.accept(req, bytes, proof, input.signingKey, ticket.owner);
  if (deps.tickets.take(input.ticket, now) === undefined) throw staleTicket();
  await deps.store.enroll({
    agent: ticket.agent,
    owner: ticket.owner,
    keyId: proof.keyId,
    signingKey: input.signingKey,
    sealingKey: input.sealingKey,
    enrolledBy: ticket.userId,
    enrolledAt: new Date(now).toISOString(),
  });
  log.info({ agent: ticket.agent, owner: ticket.owner, keyId: proof.keyId }, 'boxes: a box enrolled with its organization');
  return { server: ticket.agent, organization: ticket.owner, keyId: proof.keyId };
}

async function session(req: IncomingMessage, deps: EnrollmentDeps): Promise<unknown> {
  refuseBrowser(req);
  const bytes = await readBodyBytes(req, BODY_MAX);
  const proof = deps.auth.proofOf(req);
  const row = await deps.store.find(proof.keyId);
  if (row === null) throw notEnrolled();
  deps.auth.accept(req, bytes, proof, row.signingKey, row.owner);
  return { server: row.agent, organization: row.owner, keyId: row.keyId, enrolledAt: row.enrolledAt };
}

function answer(req: IncomingMessage, deps: EnrollmentDeps, path: string, minted: string | null): Promise<unknown> {
  if (!deps.enabled()) return Promise.reject(new ApiError('Organization connectors are not switched on yet.', 503));
  if (minted !== null) return mint(req, deps, minted);
  return path === ENROLL ? enroll(req, deps) : session(req, deps);
}

function routeOf(path: string): { minted: string | null; method: string } | null {
  const minted = MINT_RE.exec(path)?.[1] ?? null;
  if (minted !== null) return { minted, method: 'POST' };
  if (path === ENROLL) return { minted: null, method: 'POST' };
  return path === SESSION ? { minted: null, method: 'GET' } : null;
}

export function handleEnrollmentRequest(req: IncomingMessage, res: ServerResponse, deps: EnrollmentDeps): boolean {
  const path = (req.url ?? '').split('?')[0] ?? '';
  const route = routeOf(path);
  if (route === null) return false;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors(req)).end();
    return true;
  }
  const { minted, method } = route;
  if (req.method !== method) {
    res.setHeader('allow', `${method}, OPTIONS`);
    sendJson(req, res, 405, { error: 'method not allowed' });
    return true;
  }
  answer(req, deps, path, minted).then((body) => {
    sendJson(req, res, 200, body);
  }).catch((err: unknown) => {
    apiFailure(req, res, err, 'boxes');
  });
  return true;
}
