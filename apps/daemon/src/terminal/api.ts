import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApiError } from '@metro-labs/http/api-error';
import { apiFailure, apiSession, bodyField, cors, readJsonBody, sendJson } from '@metro-labs/http/api-http';
import { log } from '@metro-labs/core/log';
import { mintTerminalTicket } from './tickets.js';

const PREFIX = '/api/terminal';
const TICKETS = `${PREFIX}/tickets`;
const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

export const tmuxCommand = (session: string, home = homedir()): string[] => [
  'tmux',
  'new-session',
  '-A',
  '-D',
  '-s',
  session,
  '-c',
  home,
  ';',
  'set-option',
  '-g',
  'mouse',
  'on',
  ';',
  'set-option',
  '-s',
  'set-clipboard',
  'on',
];

export interface TerminalApiDeps {
  authorize: (subject: string) => void;
  command?: (session: string) => string[];
}

function tmuxAvailable(deps: TerminalApiDeps): boolean {
  if (deps.command !== undefined) return true;
  const run = spawnSync('tmux', ['-V'], { stdio: 'ignore' });
  return run.error === undefined && run.status === 0;
}

export function tmuxSessions(): string[] {
  const run = spawnSync('tmux', ['list-sessions', '-F', '#{session_name}'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  if (run.error !== undefined || run.status !== 0) return [];
  return run.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => SESSION_RE.test(l));
}

export function sessionOf(raw: unknown): string {
  if (raw === undefined || raw === null || raw === '')
    throw new ApiError('name the tmux session to open; GET /api/terminal lists the ones that exist', 400);
  if (typeof raw !== 'string' || !SESSION_RE.test(raw))
    throw new ApiError('a session name is 1 to 32 letters, digits, dots, dashes or underscores', 400);
  return raw;
}

export function handleTerminalRequest(req: IncomingMessage, res: ServerResponse, deps: TerminalApiDeps): boolean {
  const path = (req.url ?? '').split('?')[0] ?? '';
  if (path !== PREFIX && path !== TICKETS) return false;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors(req)).end();
    return true;
  }
  const wanted = path === TICKETS ? 'POST' : 'GET';
  if (req.method !== wanted) {
    sendJson(req, res, 405, { error: 'method not allowed' });
    return true;
  }
  apiSession(req)
    .then(async (session) => {
      if (!session) throw new ApiError('unauthorized', 401);
      deps.authorize(session.subject);
      if (path === PREFIX) {
        sendJson(req, res, 200, { available: tmuxAvailable(deps), sessions: tmuxSessions() });
        return;
      }
      const wanted = sessionOf(bodyField(await readJsonBody(req), 'session'));
      const minted = mintTerminalTicket(session.subject, wanted);
      log.info({ subject: session.subject, session: wanted }, 'terminal: ticket minted');
      sendJson(req, res, 200, { ...minted, session: wanted, path: `${PREFIX}/${minted.ticket}` });
    })
    .catch((err: unknown) => {
      apiFailure(req, res, err, 'terminal-api');
    });
  return true;
}
