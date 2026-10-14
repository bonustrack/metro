import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { parseId } from '@metro-labs/core/ids';
import { isRecord } from '@metro-labs/core/is-record';
import { log } from '@metro-labs/core/log';
import { ApiError } from '@metro-labs/http/api-error';
import { readJsonBody, sessionRoute, type ApiSession } from '@metro-labs/http/api-http';
import { agentsDir } from '../agents/files.js';
import { clearPendingAgentKey, newAgentKey, readPendingAgentKey, saveAgentKey, savePendingAgentKey, type AgentKey } from './agent-key.js';
import { agentCall, METRO_API, MetroApiRefusal, type MetroApi } from './metro-api.js';

const PATH = '/api/enrollment';
const TICKET_RE = /^[A-Za-z0-9_-]{43}$/;
const enrolling = new Set<string>();

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

const differently = (): ApiError => new ApiError('api.metro.box enrolled this agent differently than Metro asked. Try enrolling again.', 503);

function enrolledOf(value: Record<string, unknown>, key: AgentKey, owner: string): Enrolled {
  const server = parseId(value.server);
  if (server === null || value.organization !== owner || value.keyId !== key.keyId) throw differently();
  return { server, organization: owner, keyId: key.keyId };
}

function sameOwner(deps: EnrollApiDeps, owner: string): void {
  if (deps.owner() !== owner) throw new ApiError('This agent changed organizations during enrollment. Enroll it again from its current organization.', 409);
}

async function recover(api: MetroApi, key: AgentKey, owner: string): Promise<Enrolled | null> {
  try {
    return enrolledOf(await agentCall(api, key, '/api/agents/session'), key, owner);
  } catch (err) {
    if (err instanceof MetroApiRefusal && err.upstreamStatus === 401 && err.code === 'agent_key_missing') return null;
    throw err;
  }
}

function saveRecovered(pending: ReturnType<typeof readPendingAgentKey>, enrolled: Enrolled | null, ticketHash: string, api: MetroApi, dir: string): Enrolled | null {
  if (pending === null || enrolled === null) return null;
  if (pending.expectedServer !== null && pending.expectedServer !== enrolled.server) throw differently();
  saveAgentKey(pending, { server: enrolled.server, organization: enrolled.organization, at: new Date(api.now()).toISOString() }, dir);
  if (pending.ticketHash !== ticketHash) return null;
  clearPendingAgentKey(dir);
  return enrolled;
}

async function exchange(ticket: string, owner: string, dir: string, deps: EnrollApiDeps): Promise<Enrolled> {
  const api = deps.api ?? METRO_API;
  const pending = readPendingAgentKey(owner, dir);
  const ticketHash = createHash('sha256').update(ticket).digest('base64url');
  const recovered = pending === null ? null : await recover(api, pending, owner);
  sameOwner(deps, owner);
  const finished = saveRecovered(pending, recovered, ticketHash, api, dir);
  if (finished !== null) return finished;
  const key = pending?.ticketHash === ticketHash ? pending : newAgentKey();
  if (key !== pending) savePendingAgentKey(key, owner, ticketHash, dir);
  const enrolled = enrolledOf(await agentCall(api, key, '/api/agents/enroll', { ticket, organization: owner, signingKey: key.signingKey }), key, owner);
  sameOwner(deps, owner);
  savePendingAgentKey(key, owner, ticketHash, dir, enrolled.server);
  const confirmed = enrolledOf(await agentCall(api, key, '/api/agents/session'), key, owner);
  sameOwner(deps, owner);
  if (confirmed.server !== enrolled.server) throw differently();
  saveAgentKey(key, { server: enrolled.server, organization: owner, at: new Date(api.now()).toISOString() }, dir);
  clearPendingAgentKey(dir);
  log.info({ server: enrolled.server, organization: owner, keyId: key.keyId }, 'enrollment: this agent is enrolled with its organization on api.metro.box');
  return enrolled;
}

async function enroll(req: IncomingMessage, session: ApiSession, deps: EnrollApiDeps): Promise<Enrolled> {
  const body = await readJsonBody(req);
  const ticket = isRecord(body) && typeof body.ticket === 'string' ? body.ticket : '';
  if (!TICKET_RE.test(ticket)) throw new ApiError('enrolling needs the ticket api.metro.box gave for this agent', 400);
  const owner = deps.owner();
  if (owner === null || owner !== session.subject) throw new ApiError('this machine has no organization yet', 409);
  const dir = resolve(deps.dir?.() ?? agentsDir());
  if (enrolling.has(dir)) throw new ApiError('This agent is already enrolling. Wait for it to finish before trying again.', 409);
  enrolling.add(dir);
  try {
    return await exchange(ticket, owner, dir, deps);
  } finally {
    enrolling.delete(dir);
  }
}

export function handleEnrollRequest(req: IncomingMessage, res: ServerResponse, deps: EnrollApiDeps): boolean {
  return sessionRoute(req, res, { methods: { [PATH]: ['POST'] }, admin: true, label: 'enrollment' }, (session) => enroll(req, session, deps));
}
