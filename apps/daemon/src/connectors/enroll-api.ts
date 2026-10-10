import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseId } from '@metro-labs/core/ids';
import { isRecord } from '@metro-labs/core/is-record';
import { log } from '@metro-labs/core/log';
import { ApiError } from '@metro-labs/http/api-error';
import { readJsonBody, sessionRoute, type ApiSession } from '@metro-labs/http/api-http';
import { agentsDir } from '../agents/files.js';
import { newBoxKey, saveBoxKey, type BoxKey } from './box-key.js';
import { boxCall, METRO_API, type MetroApi } from './metro-api.js';

const PATH = '/api/enrollment';
const TICKET_RE = /^[A-Za-z0-9_-]{43}$/;

export interface EnrollApiDeps {
  owner: () => string | null;
  dir?: () => string;
  api?: MetroApi;
}

export interface Enrolled {
  server: string;
  organization: string;
  keyId: string;
}

const differently = (): ApiError => new ApiError('api.metro.box enrolled this box differently than Metro asked. Nothing was saved.', 503);

function enrolledOf(value: Record<string, unknown>, key: BoxKey, owner: string): Enrolled {
  const server = parseId(value.server);
  if (server === null || value.organization !== owner || value.keyId !== key.keyId) throw differently();
  return { server, organization: owner, keyId: key.keyId };
}

async function enroll(req: IncomingMessage, session: ApiSession, deps: EnrollApiDeps): Promise<Enrolled> {
  const body = await readJsonBody(req);
  const ticket = isRecord(body) && typeof body.ticket === 'string' ? body.ticket : '';
  if (!TICKET_RE.test(ticket)) throw new ApiError('enrolling needs the ticket api.metro.box gave for this agent', 400);
  const owner = deps.owner();
  if (owner === null || owner !== session.subject) throw new ApiError('this machine has no organization yet', 409);
  const api = deps.api ?? METRO_API;
  const key = newBoxKey();
  const enrolled = enrolledOf(await boxCall(api, key, '/api/boxes/enroll', { ticket, organization: owner, signingKey: key.signingKey, sealingKey: key.sealingKey }), key, owner);
  const confirmed = enrolledOf(await boxCall(api, key, '/api/boxes/session'), key, owner);
  if (confirmed.server !== enrolled.server) throw differently();
  saveBoxKey(key, { server: enrolled.server, organization: owner, at: new Date(api.now()).toISOString() }, deps.dir?.() ?? agentsDir());
  log.info({ server: enrolled.server, organization: owner, keyId: key.keyId }, 'enrollment: this box is enrolled with its organization on api.metro.box');
  return enrolled;
}

export function handleEnrollRequest(req: IncomingMessage, res: ServerResponse, deps: EnrollApiDeps): boolean {
  return sessionRoute(req, res, { methods: { [PATH]: ['POST'] }, admin: true, label: 'enrollment' }, (session) => enroll(req, session, deps));
}
