import type { IncomingMessage, ServerResponse } from 'node:http';
import { errMsg, log } from './log.js';
import { apiFailure, apiSession, cors, sendJson } from './api-http.js';
import { ApiError } from './api-error.js';
import {
  claudeDir,
  deleteClaudeSession,
  listClaudeProjects,
  listClaudeSessions,
  listMemory,
  readMemoryFile,
  readTranscript,
} from './claude-files.js';

const PREFIX = '/api/claude';
const PAGE = 100;
const PAGE_MAX = 500;

export interface ClaudeApiDeps {
  authorize: (subject: string) => void;
  dir?: () => string;
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
};

const ITEMS: Record<string, Handler> = {
  sessions: (query, dir, id) => {
    const { offset, limit } = pageOf(query);
    return readTranscript(projectOf(query), id, offset, limit, dir);
  },
  memory: (query, dir, name) => ({ name, content: readMemoryFile(projectOf(query), name, dir) }),
};

function answer(method: string, path: string, query: URLSearchParams, dir: string): unknown {
  const rest = path.slice(PREFIX.length + 1).split('/').filter(Boolean);
  const [head = '', item] = rest;
  if (method === 'DELETE') {
    if (rest.length !== 2 || head !== 'sessions') throw new ApiError('method not allowed', 405);
    deleteClaudeSession(projectOf(query), item ?? '', dir);
    return { deleted: item };
  }
  const handler = rest.length === 1 ? COLLECTIONS[head] : rest.length === 2 ? ITEMS[head] : undefined;
  if (handler === undefined) throw new ApiError('no such route', 404);
  return handler(query, dir, item ?? '');
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
  if (req.method !== 'GET' && req.method !== 'DELETE') {
    sendJson(req, res, 405, { error: 'method not allowed' });
    return true;
  }
  const session = apiSession(req);
  if (!session) {
    sendJson(req, res, 401, { error: 'unauthorized' });
    return true;
  }
  Promise.resolve()
    .then(() => {
      deps.authorize(session.subject);
      return answer(req.method ?? 'GET', path, new URLSearchParams(search), (deps.dir ?? claudeDir)());
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
