import { spawnSync } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApiError } from './api-error.js';
import { apiFailure, apiSession, cors, sendJson } from './api-http.js';
import { log } from './log.js';
import { mintTerminalTicket } from './terminal-tickets.js';

const PREFIX = '/api/terminal';
const TICKETS = `${PREFIX}/tickets`;
export const TMUX_SESSION = 'metro';
export const DEFAULT_TERMINAL_COMMAND = ['tmux', 'new-session', '-A', '-s', TMUX_SESSION];

export interface TerminalApiDeps {
  authorize: (subject: string) => void;
  command?: string[];
}

function tmuxAvailable(command: string[]): boolean {
  const bin = command[0] ?? '';
  if (bin !== 'tmux') return true;
  const run = spawnSync('tmux', ['-V'], { stdio: 'ignore' });
  return run.error === undefined && run.status === 0;
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
    .then((session) => {
      if (!session) throw new ApiError('unauthorized', 401);
      deps.authorize(session.subject);
      const command = deps.command ?? DEFAULT_TERMINAL_COMMAND;
      if (path === PREFIX) {
        sendJson(req, res, 200, { available: tmuxAvailable(command), session: TMUX_SESSION, command });
        return;
      }
      const minted = mintTerminalTicket(session.subject);
      log.info({ subject: session.subject }, 'terminal: ticket minted');
      sendJson(req, res, 200, { ...minted, path: `${PREFIX}/${minted.ticket}` });
    })
    .catch((err: unknown) => {
      apiFailure(req, res, err, 'terminal-api');
    });
  return true;
}
