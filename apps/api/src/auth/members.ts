import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SlugStore } from '../slug.js';
import { AVATAR_BODY_MAX, parseAvatar, type OrganizationAvatars } from '../avatar.js';
import { log } from '@metro-labs/core/log';
import { isRecord } from '@metro-labs/core/is-record';
import { ApiError } from '@metro-labs/http/api-error';
import { apiFailure, cors, readJsonBody, sendJson } from '@metro-labs/http/api-http';
import { bearerSession, type KeySource, type Session } from '@metro-labs/http/user-token';
import { isRole, ORGANIZATION_NAME_RE, type Directory, type Member } from './directory.js';

const PREFIX = '/api/organization';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ID_RE = /^[A-Za-z0-9_]{6,80}$/;

interface MembersApiDeps {
  directory: Directory;
  keys: KeySource;
  slugs: SlugStore;
  orgAvatars: OrganizationAvatars;
}

type Target = { kind: 'organization' } | { kind: 'avatar' } | { kind: 'add' } | { kind: 'member'; id: string } | { kind: 'unknown' } | null;

function subTarget(parts: string[]): Target {
  if (parts[0] === 'invitations' && parts.length === 1) return { kind: 'add' };
  if (parts[0] === 'avatar' && parts.length === 1) return { kind: 'avatar' };
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
  avatar: ['PUT'],
  add: ['POST'],
  member: ['PUT', 'DELETE'],
};

const admin = (session: Session): void => {
  if (session.role !== 'admin') throw new ApiError('this needs the admin role in your organization', 403);
};

function changes(body: unknown): { name: string | null; slug: string | null } {
  const name = isRecord(body) && typeof body.name === 'string' ? body.name.trim() : null;
  const slug = isRecord(body) && typeof body.slug === 'string' ? body.slug : null;
  if (name === null && slug === null) throw new ApiError('send a name or a slug', 400);
  if (name !== null && !ORGANIZATION_NAME_RE.test(name)) throw new ApiError('the organization name must be 2 to 64 characters', 400);
  return { name, slug };
}

async function rename(req: IncomingMessage, deps: MembersApiDeps, directory: Directory, session: Session, organization: string): Promise<unknown> {
  admin(session);
  const { name, slug } = changes(await readJsonBody(req));
  const savedName = name === null ? await directory.organizationName(organization) : await directory.renameOrganization(organization, name);
  const savedSlug = slug === null ? await deps.slugs.ensure(organization, savedName) : await deps.slugs.set(organization, slug);
  log.info({ organization, name: savedName, slug: savedSlug, by: session.userId }, 'members: organization changed');
  return { id: organization, name: savedName, slug: savedSlug };
}

async function setAvatar(req: IncomingMessage, deps: MembersApiDeps, directory: Directory, session: Session, organization: string): Promise<unknown> {
  admin(session);
  const body = await readJsonBody(req, AVATAR_BODY_MAX);
  const avatar = parseAvatar(isRecord(body) ? body.avatar : undefined);
  await deps.slugs.ensure(organization, await directory.organizationName(organization));
  await deps.orgAvatars.setAvatar(organization, avatar);
  log.info({ organization, avatar: avatar !== null, by: session.userId }, 'members: organization avatar changed');
  return { id: organization, avatar };
}

async function overview(deps: MembersApiDeps, directory: Directory, session: Session, organization: string): Promise<unknown> {
  const [name, members] = await Promise.all([directory.organizationName(organization), directory.listMembers(organization)]);
  const slug = await deps.slugs.ensure(organization, name);
  const avatars = await deps.orgAvatars.avatars([organization]);
  return { id: organization, name, slug, avatar: avatars.get(organization) ?? null, self: session.userId, role: session.role, members };
}

async function add(req: IncomingMessage, directory: Directory, session: Session, organization: string): Promise<unknown> {
  admin(session);
  const body = await readJsonBody(req);
  const email = isRecord(body) && typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const role = isRecord(body) ? body.role : undefined;
  if (!EMAIL_RE.test(email)) throw new ApiError('email does not look like an address', 400);
  if (!isRole(role)) throw new ApiError('role must be admin or member', 400);
  const added = await directory.addMember(organization, email, role, session.userId);
  log.info({ organization, email, role, by: session.userId }, 'members: member added by email');
  return added;
}

function memberOrThrow(members: Member[], id: string): Member {
  const found = members.find((m) => m.membershipId === id);
  if (found === undefined) throw new ApiError('no such member', 404);
  return found;
}

const lastAdmin = (members: Member[], target: Member): boolean => target.role === 'admin' && members.filter((m) => m.role === 'admin').length === 1;

async function changeMember(req: IncomingMessage, directory: Directory, session: Session, organization: string, id: string): Promise<unknown> {
  admin(session);
  const members = await directory.listMembers(organization);
  const found = memberOrThrow(members, id);
  if (req.method === 'DELETE') {
    if (found.userId === session.userId) throw new ApiError('you cannot remove yourself', 400);
    if (lastAdmin(members, found)) throw new ApiError('the organization needs at least one admin', 400);
    await directory.removeMembership({ organization, member: found, by: session.userId });
    log.info({ organization, removed: found.userId, by: session.userId }, 'members: member removed');
    return { removed: true };
  }
  return roleChange(req, directory, session, organization, members, found);
}

async function roleChange(req: IncomingMessage, directory: Directory, session: Session, organization: string, members: Member[], found: Member): Promise<unknown> {
  const body = await readJsonBody(req);
  const role = isRecord(body) ? body.role : undefined;
  if (!isRole(role)) throw new ApiError('role must be admin or member', 400);
  if (found.userId === session.userId && role !== 'admin') throw new ApiError('you cannot take your own admin role away', 400);
  if (role === 'member' && lastAdmin(members, found)) throw new ApiError('the organization needs at least one admin', 400);
  await directory.setMembershipRole({ organization, member: found, role, by: session.userId });
  log.info({ member: found.userId, role, by: session.userId }, 'members: role changed');
  return { ...found, role };
}

async function answer(req: IncomingMessage, deps: MembersApiDeps, tgt: Exclude<NonNullable<Target>, { kind: 'unknown' }>): Promise<unknown> {
  const session = await bearerSession(req, deps.keys);
  if (session === null) throw new ApiError('unauthorized', 401);
  if (session.organization === null) throw new ApiError('you have no organization yet', 409);
  const { directory } = deps;
  if (tgt.kind === 'organization') return req.method === 'PUT' ? rename(req, deps, directory, session, session.organization) : overview(deps, directory, session, session.organization);
  if (tgt.kind === 'avatar') return setAvatar(req, deps, directory, session, session.organization);
  if (tgt.kind === 'add') return add(req, directory, session, session.organization);
  return changeMember(req, directory, session, session.organization, tgt.id);
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
