import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { sessionRoute } from '@metro-labs/http/api-http';
import { MOVE_LOG, moveState, startMove } from './move.js';
import { rootHelper, runningAsMetro, runningAsRoot } from './privilege.js';
import { HELPER_VERSION } from './helper-script.js';

const PATH = '/api/server/metro-user';
const LOG_TAIL = 40;

function logTail(): string {
  try {
    return readFileSync(MOVE_LOG, 'utf8').split('\n').slice(-LOG_TAIL).join('\n');
  } catch {
    return '';
  }
}

function helperVersion(): number | null {
  if (!runningAsMetro()) return null;
  const v = Number(rootHelper(['version']).stdout.trim());
  return Number.isInteger(v) ? v : null;
}

function view(): unknown {
  const runningAs = runningAsRoot() ? 'root' : runningAsMetro() ? 'metro' : 'other';
  const helper = helperVersion();
  return {
    runningAs,
    canMove: runningAs === 'root',
    move: moveState(),
    log: logTail(),
    helper,
    helperCurrent: runningAs !== 'metro' || helper === HELPER_VERSION,
  };
}

export function handleMetroUserRequest(req: IncomingMessage, res: ServerResponse): boolean {
  return sessionRoute(req, res, { methods: { [PATH]: ['GET', 'POST'] }, admin: true, label: 'metro-user-api' }, () => {
    if (req.method === 'POST') startMove();
    return Promise.resolve(view());
  });
}
