import type { IncomingMessage, ServerResponse } from 'node:http';
import { log } from '@metro-labs/core/log';
import { isRecord } from '@metro-labs/core/is-record';
import { ApiError } from '@metro-labs/http/api-error';
import { apiFailure, cors, readJsonBody, sendJson } from '@metro-labs/http/api-http';
import { bearerSession, type Session, type SigningKeys } from '@metro-labs/http/workos-token';
import {
  isRole,
  listInvitations,
  listMembers,
  ORGANIZATION_NAME_RE,
  organizationName,
  removeMembership,
  renameOrganization,
  revokeInvitation,
  sendInvitation,
  setMembershipRole,
  type Member,
  type WorkosConfig,
} from './workos.js';

const PREFIX = '/api/organization';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ID_RE = /^[A-Za-z0-9_]{6,80}$/;

export interface MembersApiDeps {
  config: () => WorkosConfig | null;
  keys: SigningKeys;
}

type Target = { kind: 'organization' } | { kind: 'invitations' } | { kind: 'invitation'; id: string } | { kind: 'member'; id: string } | { kind: 'unknown' } | null;

function invitationTarget(parts: string[]): Target {
  const id = parts[1] ?? '';
  if (parts.length === 1) return { kind: 'invitations' };
  if (parts.length === 3 && parts[2] === 'revoke' && ID_RE.test(id)) return { kind: 'invitation', id };
  return { kind: 'unknown' };
}

function subTarget(parts: string[]): Target {
  if (parts[0] === 'invitations') return invitationTarget(parts);
  const id = parts[1] ?? '';
  if (parts[0] === 'members' && parts.length === 2 && ID_RE.test(id)) return { kind: 'member', id };
  return { kind: 'unknown' };
}

function target(path: string): Target {
  if (path === PREFIX || path === `${PREFIX}/`) return { kind: 'organization' };
  if (!path.startsWith(`${PREFIX}/`)) return null;
  return subTarget(path.slice(PREFIX.length + 1).split('/').filter(Boolean));
}

const METHODS: Record<Exclude<NonNullable<Target>, { kind: 'unknown' }>['kind'], string[]> = {
  organization: ['GET', 'PUT'],
  invitations: ['POST'],
  invitation: ['POST'],
  member: ['PUT', 'DELETE'],
};

function ready(deps: MembersApiDeps): WorkosConfig {
  const cfg = deps.config();
  if (cfg === null) throw new ApiError('sign-in is not configured on this server', 503);
  return cfg;
}

const admin = (session: Session): void => {
  if (session.role !== 'admin') throw new ApiError('this needs the admin role in your organization', 403);
};

async function rename(req: IncomingMessage, cfg: WorkosConfig, session: Session, organization: string): Promise<unknown> {
  admin(session);
  const body = await readJsonBody(req);
  const name = isRecord(body) && typeof body.name === 'string' ? body.name.trim() : '';
  if (!ORGANIZATION_NAME_RE.test(name)) throw new ApiError('the organization name must be 2 to 64 characters', 400);
  const saved = await renameOrganization(cfg, organization, name);
  log.info({ organization, name: saved, by: session.userId }, 'members: organization renamed');
  return { id: organization, name: saved };
}

async function overview(cfg: WorkosConfig, session: Session, organization: string): Promise<unknown> {
  const [name, members, invitations] = await Promise.all([organizationName(cfg, organization), listMembers(cfg, organization), listInvitations(cfg, organization)]);
  return { id: organization, name, self: session.userId, role: session.role, members, invitations };
}

async function invite(req: IncomingMessage, cfg: WorkosConfig, session: Session, organization: string): Promise<unknown> {
  admin(session);
  const body = await readJsonBody(req);
  const email = isRecord(body) && typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const role = isRecord(body) ? body.role : undefined;
  if (!EMAIL_RE.test(email)) throw new ApiError('email does not look like an address', 400);
  if (!isRole(role)) throw new ApiError('role must be admin or member', 400);
  const sent = await sendInvitation(cfg, organization, email, role, session.userId);
  log.info({ organization, email, role, by: session.userId }, 'members: invitation sent');
  return sent;
}

function memberOrThrow(members: Member[], id: string): Member {
  const found = members.find((m) => m.membershipId === id);
  if (found === undefined) throw new ApiError('no such member', 404);
  return found;
}

const lastAdmin = (members: Member[], target: Member): boolean => target.role === 'admin' && members.filter((m) => m.role === 'admin').length === 1;

async function changeMember(req: IncomingMessage, cfg: WorkosConfig, session: Session, organization: string, id: string): Promise<unknown> {
  admin(session);
  const members = await listMembers(cfg, organization);
  const found = memberOrThrow(members, id);
  if (req.method === 'DELETE') {
    if (found.userId === session.userId) throw new ApiError('you cannot remove yourself', 400);
    if (lastAdmin(members, found)) throw new ApiError('the organization needs at least one admin', 400);
    await removeMembership(cfg, id);
    log.info({ organization, removed: found.userId, by: session.userId }, 'members: member removed');
    return { removed: true };
  }
  return roleChange(req, cfg, session, members, found);
}

async function roleChange(req: IncomingMessage, cfg: WorkosConfig, session: Session, members: Member[], found: Member): Promise<unknown> {
  const body = await readJsonBody(req);
  const role = isRecord(body) ? body.role : undefined;
  if (!isRole(role)) throw new ApiError('role must be admin or member', 400);
  if (found.userId === session.userId && role !== 'admin') throw new ApiError('you cannot take your own admin role away', 400);
  if (role === 'member' && lastAdmin(members, found)) throw new ApiError('the organization needs at least one admin', 400);
  await setMembershipRole(cfg, found.membershipId, role);
  log.info({ member: found.userId, role, by: session.userId }, 'members: role changed');
  return { ...found, role };
}

async function answer(req: IncomingMessage, deps: MembersApiDeps, tgt: Exclude<NonNullable<Target>, { kind: 'unknown' }>): Promise<unknown> {
  const session = await bearerSession(req, deps.keys);
  if (session === null) throw new ApiError('unauthorized', 401);
  if (session.organization === null) throw new ApiError('you have no organization yet', 409);
  const cfg = ready(deps);
  if (tgt.kind === 'organization') return req.method === 'PUT' ? rename(req, cfg, session, session.organization) : overview(cfg, session, session.organization);
  if (tgt.kind === 'invitations') return invite(req, cfg, session, session.organization);
  if (tgt.kind === 'invitation') {
    admin(session);
    await revokeInvitation(cfg, tgt.id);
    return { revoked: true };
  }
  return changeMember(req, cfg, session, session.organization, tgt.id);
}

export function handleMembersApiRequest(req: IncomingMessage, res: ServerResponse, deps: MembersApiDeps): boolean {
  const tgt = target((req.url ?? '').split('?')[0] ?? '');
  if (tgt === null) return false;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors(req)).end();
    return true;
  }
  if (tgt.kind === 'unknown') {
    sendJson(req, res, 404, { error: 'not found' });
    return true;
  }
  if (!METHODS[tgt.kind].includes(req.method ?? '')) {
    sendJson(req, res, 405, { error: 'method not allowed' });
    return true;
  }
  answer(req, deps, tgt)
    .then((body) => {
      sendJson(req, res, 200, body);
    })
    .catch((err: unknown) => {
      apiFailure(req, res, err, 'members-api');
    });
  return true;
}
