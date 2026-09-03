import type { IncomingMessage, ServerResponse } from 'node:http';
import { errMsg, log } from './log.js';
import {
  apiFailure,
  apiSession,
  bodyField,
  cors,
  readJsonBody,
  sendJson,
  type ApiSession,
} from './api-http.js';
import { parseId } from '../db/ids.js';
import type { Member, Project } from '../db/projects.js';

const PREFIX = '/api/projects';

export interface ProjectApiDeps {
  listProjects: (subject: string) => Promise<Project[]>;
  createProject: (subject: string, name: unknown) => Promise<Project>;
  renameProject: (
    subject: string,
    id: string,
    name: unknown,
  ) => Promise<Project>;
  deleteProject: (
    subject: string,
    id: string,
  ) => Promise<{ id: string; name: string }>;
  listMembers: (subject: string, id: string) => Promise<Member[]>;
  addMember: (
    subject: string,
    id: string,
    invited: unknown,
    role: unknown,
  ) => Promise<Member[]>;
  setMemberRole: (
    subject: string,
    id: string,
    memberId: string,
    role: unknown,
  ) => Promise<Member[]>;
  removeMember: (
    subject: string,
    id: string,
    memberId: string,
  ) => Promise<Member[]>;
}

type Routable =
  | { kind: 'index' }
  | { kind: 'project'; id: string }
  | { kind: 'rename'; id: string }
  | { kind: 'members'; id: string }
  | { kind: 'member'; id: string; memberId: string };

type Target = Routable | { kind: 'unknown' } | null;

const ALLOWED: Record<Routable['kind'], string[]> = {
  index: ['GET', 'POST'],
  project: ['DELETE'],
  rename: ['POST'],
  members: ['GET', 'POST'],
  member: ['POST', 'DELETE'],
};

function memberTarget(id: string, rest: string[]): Target {
  if (rest.length === 1) return { kind: 'members', id };
  if (rest.length > 2) return { kind: 'unknown' };
  const memberId = parseId(rest[1] ?? '');
  return memberId === null
    ? { kind: 'unknown' }
    : { kind: 'member', id, memberId };
}

function subTarget(id: string, rest: string[]): Target {
  if (rest.length === 0) return { kind: 'project', id };
  const head = rest[0];
  if (head === 'members') return memberTarget(id, rest);
  if (rest.length > 1) return { kind: 'unknown' };
  if (head === 'rename') return { kind: 'rename', id };
  return { kind: 'unknown' };
}

function target(path: string): Target {
  if (path === PREFIX || path === `${PREFIX}/`) return { kind: 'index' };
  if (!path.startsWith(`${PREFIX}/`)) return null;
  const segments = path.slice(PREFIX.length + 1).split('/').filter(Boolean);
  const head = segments[0];
  if (head === undefined) return { kind: 'index' };
  const id = parseId(head);
  return id === null ? { kind: 'unknown' } : subTarget(id, segments.slice(1));
}

async function handleIndex(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ProjectApiDeps,
  session: ApiSession,
): Promise<void> {
  if (req.method === 'GET') {
    sendJson(req, res, 200, { projects: await deps.listProjects(session.subject) });
    return;
  }
  const made = await deps.createProject(
    session.subject,
    bodyField(await readJsonBody(req), 'name'),
  );
  log.info({ id: made.id, name: made.name }, 'project-api: created project');
  sendJson(req, res, 201, made);
}

async function handleMembers(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ProjectApiDeps,
  session: ApiSession,
  id: string,
): Promise<void> {
  if (req.method === 'GET') {
    sendJson(req, res, 200, { members: await deps.listMembers(session.subject, id) });
    return;
  }
  const body = await readJsonBody(req);
  const members = await deps.addMember(
    session.subject,
    id,
    bodyField(body, 'address'),
    bodyField(body, 'role'),
  );
  sendJson(req, res, 200, { members });
}

async function handleMember(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ProjectApiDeps,
  session: ApiSession,
  tgt: { id: string; memberId: string },
): Promise<void> {
  if (req.method === 'DELETE') {
    const members = await deps.removeMember(session.subject, tgt.id, tgt.memberId);
    sendJson(req, res, 200, { members });
    return;
  }
  const members = await deps.setMemberRole(
    session.subject,
    tgt.id,
    tgt.memberId,
    bodyField(await readJsonBody(req), 'role'),
  );
  sendJson(req, res, 200, { members });
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ProjectApiDeps,
  session: ApiSession,
  tgt: Routable,
): Promise<void> {
  try {
    if (tgt.kind === 'index') await handleIndex(req, res, deps, session);
    else if (tgt.kind === 'members')
      await handleMembers(req, res, deps, session, tgt.id);
    else if (tgt.kind === 'member')
      await handleMember(req, res, deps, session, tgt);
    else if (tgt.kind === 'rename')
      sendJson(
        req,
        res,
        200,
        await deps.renameProject(
          session.subject,
          tgt.id,
          bodyField(await readJsonBody(req), 'name'),
        ),
      );
    else sendJson(req, res, 200, await deps.deleteProject(session.subject, tgt.id));
  } catch (err) {
    apiFailure(req, res, err, 'project-api');
  }
}

export function handleProjectApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ProjectApiDeps,
): boolean {
  const tgt = target((req.url ?? '').split('?')[0] ?? '');
  if (tgt === null) return false;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors(req)).end();
    return true;
  }
  if (tgt.kind === 'unknown') {
    sendJson(req, res, 404, { error: 'no such project' });
    return true;
  }
  if (!ALLOWED[tgt.kind].includes(req.method ?? '')) {
    sendJson(req, res, 405, { error: 'method not allowed' });
    return true;
  }
  const session = apiSession(req);
  if (!session) {
    sendJson(req, res, 401, { error: 'unauthorized' });
    return true;
  }
  route(req, res, deps, session, tgt).catch((err: unknown) => {
    log.warn({ err: errMsg(err) }, 'project-api: unhandled error');
    if (!res.headersSent)
      sendJson(req, res, 500, { error: 'project api failed' });
  });
  return true;
}
