import type { IncomingMessage, ServerResponse } from 'node:http';
import { errMsg, log } from '@metro-labs/core/log';
import { apiFailure, apiSession, requireAdmin, cors, readJsonBody, sendJson, type ApiSession } from '@metro-labs/http/api-http';
import { ApiError } from '@metro-labs/http/api-error';
import { isRecord } from '@metro-labs/core/is-record';
import { githubSkillsAnswer } from './github-api.js';
import { githubSkills, type GitHubSkills } from './github-skills.js';
import { listClaudeSettings, SETTINGS_MAX, writeClaudeSettings } from './settings.js';
import {
  createClaudeSkill,
  deleteClaudeSkill,
  listClaudeSkills,
  readClaudeSkill,
  writeClaudeSkill,
} from './skills.js';
import {
  answerClaudeLogin,
  claudeAccount,
  claudeInstalled,
  claudeLoginView,
  endClaudeLogin,
  startClaudeLogin,
  type LoginDeps,
  type LoginTarget,
} from './login.js';
import { claudeLoginTarget, type ClaudeLoginDeps } from '../gateway/claude-logins.js';
import { setupAnswer, type SetupApiDeps } from './setup-api.js';
import {
  autostartEnabled,
  ensureSession,
  sessionSnapshot,
  sessionStatus,
  setAutostart,
  startSession,
  stopSession,
  type SessionDeps,
} from './session.js';
import { claudeVersion, updateClaude, type VersionDeps } from './version.js';
import { receiveSessionFile, sessionFilePath } from './session-files.js';
import { createReadStream } from '../agent-user/agent-fs.js';
import { pipeline } from 'node:stream/promises';
import {
  claudeDir,
  deleteClaudeSession,
  deleteMemoryFile,
  listClaudeProjects,
  listClaudeSessions,
  listMemory,
  readMemoryFile,
  readTranscript,
  writeMemoryFile,
} from './files.js';

const PREFIX = '/api/claude';
const BODY_MAX = SETTINGS_MAX + 4096;
const WRITABLE = new Set(['GET', 'DELETE', 'PUT', 'POST']);
const PAGE = 100;
const PAGE_MAX = 500;

export interface ClaudeApiDeps extends SetupApiDeps {
  dir?: () => string;
  login?: LoginDeps;
  claudeLogins?: ClaudeLoginDeps;
  version?: VersionDeps;
  skillSource?: GitHubSkills;
}

function projectOf(query: URLSearchParams): string {
  const project = query.get('project');
  if (project === null || project === '') throw new ApiError('project is required', 400);
  return project;
}

function pageOf(query: URLSearchParams): { offset: number; limit: number } {
  const offset = Math.max(0, Math.floor(Number(query.get('offset') ?? '0')) || 0);
  const limit = Math.min(PAGE_MAX, Math.max(1, Math.floor(Number(query.get('limit') ?? String(PAGE))) || PAGE));
  return { offset, limit };
}

type Handler = (query: URLSearchParams, dir: string, item: string) => unknown;

const COLLECTIONS: Record<string, Handler> = {
  projects: (_query, dir) => ({ projects: listClaudeProjects(dir) }),
  sessions: (query, dir) => ({ sessions: listClaudeSessions(projectOf(query), dir) }),
  memory: (query, dir) => listMemory(projectOf(query), dir),
  settings: (_query, dir) => ({ files: listClaudeSettings(dir) }),
  skills: (_query, dir) => ({ skills: listClaudeSkills(dir) }),
};

const ITEMS: Record<string, Handler> = {
  sessions: (query, dir, id) => {
    const { offset, limit } = pageOf(query);
    return readTranscript(projectOf(query), id, offset, limit, dir);
  },
  memory: (query, dir, raw) => {
    const name = decodeURIComponent(raw);
    return { name, content: readMemoryFile(projectOf(query), name, dir) };
  },
  skills: (_query, dir, id) => readClaudeSkill(decodeURIComponent(id), dir),
};

const parts = (path: string): string[] => path.slice(PREFIX.length + 1).split('/').filter(Boolean);

const seenIn = (body: Record<string, unknown>): string | null | undefined =>
  'seenAt' in body ? (typeof body.seenAt === 'string' ? body.seenAt : null) : undefined;

const WRITE_HEADS = new Set(['settings', 'skills', 'memory']);

interface Write {
  text: string;
  seen: string | null | undefined;
  modifiedAt: string | undefined;
}

function writeItem(head: string, item: string, write: Write, search: string, dir: string): unknown {
  if (head === 'skills') return writeClaudeSkill(decodeURIComponent(item), write.text, write.seen, dir);
  if (head === 'memory') return writeMemoryFile(projectOf(new URLSearchParams(search)), decodeURIComponent(item), write.text, dir, write.modifiedAt);
  return writeClaudeSettings(item, write.text, write.seen, dir);
}

async function writeAnswer(req: IncomingMessage, path: string, search: string, dir: string): Promise<unknown> {
  const [head = '', item = ''] = parts(path);
  if (!WRITE_HEADS.has(head) || item === '') throw new ApiError('method not allowed', 405);
  const body = await readJsonBody(req, BODY_MAX);
  if (!isRecord(body) || typeof body.text !== 'string') throw new ApiError('text is required', 400);
  const modifiedAt = typeof body.modifiedAt === 'string' ? body.modifiedAt : undefined;
  return writeItem(head, item, { text: body.text, seen: seenIn(body), modifiedAt }, search, dir);
}

async function created(req: IncomingMessage, path: string, dir: string): Promise<unknown> {
  const rest = parts(path);
  if (rest.length !== 1 || rest[0] !== 'skills') throw new ApiError('method not allowed', 405);
  const body = await readJsonBody(req, BODY_MAX);
  if (!isRecord(body) || typeof body.name !== 'string') throw new ApiError('name is required', 400);
  return createClaudeSkill(body.name, typeof body.text === 'string' ? body.text : undefined, dir);
}

const ADMIN_ONLY = /^\/api\/claude\/(login|session|version|setup|skill-source)(\/|$)/;
const LOGIN = 'login';
const SESSION = 'session';
const SETUP = 'setup';
const VERSION = 'version';

function sessionCommand(body: Record<string, unknown>, session: SessionDeps): unknown {
  if (body.action === 'start') {
    const status = sessionStatus(session);
    if (!status.running && status.blocked !== null) throw new ApiError(`cannot start a Claude session: ${status.blocked}`, 409);
    const started = status.running ? status : startSession(session);
    setAutostart(typeof body.autostart === 'boolean' ? body.autostart : true, session.agents);
    return { ...started, autostart: autostartEnabled(session.agents) };
  }
  if (body.action === 'stop') {
    setAutostart(false, session.agents);
    return stopSession(session, true);
  }
  if (body.action !== undefined) throw new ApiError('action must be start or stop', 400);
  if (typeof body.autostart === 'boolean') setAutostart(body.autostart, session.agents);
  if (body.autostart === true) ensureSession(session);
  return sessionStatus(session);
}

async function sessionAnswer(req: IncomingMessage, deps: ClaudeApiDeps): Promise<unknown> {
  const session = deps.session ?? {};
  const method = req.method ?? 'GET';
  if (method === 'GET') return sessionStatus(session);
  if (method !== 'POST') throw new ApiError('method not allowed', 405);
  const body = await readJsonBody(req);
  if (!isRecord(body)) throw new ApiError('a body is required', 400);
  return sessionCommand(body, session);
}

function loginTarget(req: IncomingMessage, deps: ClaudeApiDeps): LoginTarget | null {
  const asked = new URL(req.url ?? '', 'http://metro').searchParams.get('connection');
  return asked === null ? null : claudeLoginTarget(asked, deps.claudeLogins);
}

async function loginAnswer(req: IncomingMessage, id: string, deps: ClaudeApiDeps): Promise<unknown> {
  const method = req.method ?? 'GET';
  if (id === '') {
    if (method === 'POST') return startClaudeLogin(deps.login, Date.now(), loginTarget(req, deps));
    if (method === 'GET') return { available: claudeInstalled(), ...claudeAccount() };
    throw new ApiError('method not allowed', 405);
  }
  if (method === 'GET') return claudeLoginView(id);
  if (method === 'DELETE') return endClaudeLogin(id);
  if (method !== 'POST') throw new ApiError('method not allowed', 405);
  const body = await readJsonBody(req);
  if (!isRecord(body) || typeof body.text !== 'string') throw new ApiError('text is required', 400);
  return answerClaudeLogin(id, body.text);
}

function removed(rest: string[], query: URLSearchParams, dir: string): unknown {
  const [head = '', item = ''] = rest;
  if (rest.length !== 2) throw new ApiError('method not allowed', 405);
  if (head === 'skills') return { deleted: deleteClaudeSkill(decodeURIComponent(item), dir) };
  if (head === 'memory') return { deleted: deleteMemoryFile(projectOf(query), decodeURIComponent(item), dir) };
  if (head !== 'sessions') throw new ApiError('method not allowed', 405);
  deleteClaudeSession(projectOf(query), item, dir);
  return { deleted: item };
}

function answer(method: string, path: string, query: URLSearchParams, dir: string): unknown {
  const rest = parts(path);
  const [head = '', item = ''] = rest;
  if (method === 'DELETE') return removed(rest, query, dir);
  if (method !== 'GET') throw new ApiError('method not allowed', 405);
  const handler = rest.length === 1 ? COLLECTIONS[head] : rest.length === 2 ? ITEMS[head] : undefined;
  if (handler === undefined) throw new ApiError('no such route', 404);
  return handler(query, dir, item);
}

function versionAnswer(req: IncomingMessage, deps: ClaudeApiDeps): Promise<unknown> {
  const version: VersionDeps = { ...deps.version, session: deps.version?.session ?? deps.session };
  const method = req.method ?? 'GET';
  if (method === 'GET') return claudeVersion(version);
  if (method !== 'POST') throw new ApiError('method not allowed', 405);
  return updateClaude(version);
}

const SINGLETONS: Record<string, (req: IncomingMessage, deps: ClaudeApiDeps, session: ApiSession) => Promise<unknown>> = {
  [SESSION]: sessionAnswer,
  [SETUP]: setupAnswer,
  [VERSION]: versionAnswer,
};

function skillsAnswer(req: IncomingMessage, path: string, search: string, dir: string, source: GitHubSkills): unknown {
  const segments = parts(path);
  if (req.method === 'GET' && segments.length === 1) {
    const listing = source.listing();
    return { skills: [...listClaudeSkills(dir), ...listing.rows], skillSource: listing.skillSource };
  }
  const item = decodeURIComponent(segments[1] ?? '');
  if (segments.length === 2 && item.startsWith('github:')) {
    if (req.method !== 'GET') throw new ApiError('GitHub skills are read-only here. Edit the repository or remove its source.', 409);
    return source.read(item);
  }
  return fileAnswer(req, path, search, dir);
}

const sourceOf = (deps: ClaudeApiDeps): GitHubSkills => deps.skillSource ?? githubSkills();

function fileAnswer(req: IncomingMessage, path: string, search: string, dir: string): unknown {
  if (req.method === 'PUT') return writeAnswer(req, path, search, dir);
  if (req.method === 'POST') return created(req, path, dir);
  return answer(req.method ?? 'GET', path, new URLSearchParams(search), dir);
}

function routed(req: IncomingMessage, path: string, search: string, deps: ClaudeApiDeps, session: ApiSession): unknown {
  const dir = (deps.dir ?? claudeDir)();
  const [head = '', item = ''] = parts(path);
  if (head === LOGIN) return loginAnswer(req, item, deps);
  if (head === 'skill-source' && parts(path).length === 1) return githubSkillsAnswer(req, deps.skillSource);
  if (head === 'skills') return skillsAnswer(req, path, search, dir, sourceOf(deps));
  const single = item === '' ? SINGLETONS[head] : undefined;
  if (single !== undefined) return single(req, deps, session);
  return fileAnswer(req, path, search, dir);
}

const TEXT = 'text/plain; charset=utf-8';

async function streamed(req: IncomingMessage, res: ServerResponse, path: string, search: string, dir: string): Promise<boolean> {
  const [head = '', item = ''] = parts(path);
  if (head !== 'sessions' || item === '') return false;
  const query = new URLSearchParams(search);
  if (req.method === 'GET' && query.get('raw') === '1') {
    const file = sessionFilePath(projectOf(query), item, dir);
    res.writeHead(200, { 'content-type': TEXT, 'cache-control': 'no-store', ...cors(req) });
    await pipeline(createReadStream(file), res).catch(() => {
      res.destroy();
    });
    return true;
  }
  if (req.method === 'PUT') {
    if ((req.headers['content-type'] ?? '').includes('json')) throw new ApiError('send the session file as text/plain', 415);
    sendJson(req, res, 200, await receiveSessionFile(projectOf(query), item, req, dir));
    return true;
  }
  return false;
}

export function handleClaudeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ClaudeApiDeps,
): boolean {
  const [path = '', search = ''] = (req.url ?? '').split('?');
  if (path !== PREFIX && !path.startsWith(`${PREFIX}/`)) return false;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors(req)).end();
    return true;
  }
  if (!WRITABLE.has(req.method ?? '')) {
    sendJson(req, res, 405, { error: 'method not allowed' });
    return true;
  }
  apiSession(req)
    .then(async (session) => {
      if (!session) throw new ApiError('unauthorized', 401);
      if (path === `${PREFIX}/session/snapshot`) {
        if (req.method !== 'GET') throw new ApiError('method not allowed', 405);
        sendJson(req, res, 200, sessionSnapshot(deps.session));
        return;
      }
      if (req.method !== 'GET' && ADMIN_ONLY.test(path.replace(/\/{2,}/g, '/'))) requireAdmin(session);
      if (await streamed(req, res, path, search, (deps.dir ?? claudeDir)())) return;
      sendJson(req, res, 200, await routed(req, path, search, deps, session));
    })
    .catch((err: unknown) => {
      if (err instanceof ApiError) apiFailure(req, res, err, 'claude-api');
      else {
        log.warn({ err: errMsg(err) }, 'claude-api: request failed');
        if (!res.headersSent) sendJson(req, res, 500, { error: 'claude-api failed' });
      }
    });
  return true;
}
