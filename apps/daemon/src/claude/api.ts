import type { IncomingMessage, ServerResponse } from 'node:http';
import { errMsg, log } from '@metro-labs/core/log';
import { apiFailure, apiSession, cors, readJsonBody, sendJson } from '@metro-labs/http/api-http';
import { ApiError } from '@metro-labs/http/api-error';
import { isRecord } from '@metro-labs/core/is-record';
import { listClaudeSettings, SETTINGS_MAX, writeClaudeSettings } from './settings.js';
import {
  answerClaudeLogin,
  claudeAccount,
  claudeInstalled,
  claudeLoginView,
  endClaudeLogin,
  startClaudeLogin,
  type LoginDeps,
} from './login.js';
import {
  claudeDir,
  deleteClaudeSession,
  listClaudeProjects,
  listClaudeSessions,
  listMemory,
  readMemoryFile,
  readTranscript,
} from './files.js';

const PREFIX = '/api/claude';
const BODY_MAX = SETTINGS_MAX + 4096;
const WRITABLE = new Set(['GET', 'DELETE', 'PUT', 'POST']);
const PAGE = 100;
const PAGE_MAX = 500;

export interface ClaudeApiDeps {
  authorize: (subject: string) => void;
  dir?: () => string;
  login?: LoginDeps;
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
};

const ITEMS: Record<string, Handler> = {
  sessions: (query, dir, id) => {
    const { offset, limit } = pageOf(query);
    return readTranscript(projectOf(query), id, offset, limit, dir);
  },
  memory: (query, dir, name) => ({ name, content: readMemoryFile(projectOf(query), name, dir) }),
};

const parts = (path: string): string[] => path.slice(PREFIX.length + 1).split('/').filter(Boolean);

async function writeAnswer(req: IncomingMessage, path: string, dir: string): Promise<unknown> {
  const [head = '', item = ''] = parts(path);
  if (head !== 'settings' || item === '') throw new ApiError('method not allowed', 405);
  const body = await readJsonBody(req, BODY_MAX);
  if (!isRecord(body) || typeof body.text !== 'string') throw new ApiError('text is required', 400);
  const seenAt = 'seenAt' in body ? (typeof body.seenAt === 'string' ? body.seenAt : null) : undefined;
  return writeClaudeSettings(item, body.text, seenAt, dir);
}

const LOGIN = 'login';

async function loginAnswer(req: IncomingMessage, id: string, deps: ClaudeApiDeps): Promise<unknown> {
  const method = req.method ?? 'GET';
  if (id === '') {
    if (method === 'POST') return startClaudeLogin(deps.login);
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
  if (rest.length !== 2 || head !== 'sessions') throw new ApiError('method not allowed', 405);
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
    .then((session) => {
      if (!session) throw new ApiError('unauthorized', 401);
      deps.authorize(session.subject);
      const dir = (deps.dir ?? claudeDir)();
      const [head = '', item = ''] = parts(path);
      if (head === LOGIN) return loginAnswer(req, item, deps);
      if (req.method === 'PUT') return writeAnswer(req, path, dir);
      return answer(req.method ?? 'GET', path, new URLSearchParams(search), dir);
    })
    .then((body) => {
      sendJson(req, res, 200, body);
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
