import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApiError } from './api-error.js';
import { apiFailure, apiSession, cors, sendJson } from './api-http.js';
import { errMsg, log } from './log.js';

const STOP = '/api/stop';
const RESTART = '/api/restart';
const EXIT_DELAY_MS = 500;

export interface ControlApiDeps {
  authorize: (subject: string) => void;
  restart: () => void;
  stop: () => void;
  served?: () => boolean;
}

interface Action {
  run: () => void;
  body: Record<string, boolean>;
}

const servedByCli = (): boolean => (process.env.METRO_CLI_BIN?.trim() ?? '') !== '';

function actionFor(path: string, deps: ControlApiDeps): Action | null {
  if (path === STOP) return { run: deps.stop, body: { stopping: true } };
  if (path === RESTART) return { run: deps.restart, body: { restarting: true } };
  return null;
}

export function handleControlRequest(req: IncomingMessage, res: ServerResponse, deps: ControlApiDeps): boolean {
  const path = (req.url ?? '').split('?')[0] ?? '';
  const action = actionFor(path, deps);
  if (action === null) return false;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors(req)).end();
    return true;
  }
  if (req.method !== 'POST') {
    sendJson(req, res, 405, { error: 'method not allowed' });
    return true;
  }
  Promise.resolve()
    .then(async () => {
      const session = await apiSession(req);
      if (!session) throw new ApiError('unauthorized', 401);
      deps.authorize(session.subject);
      if (!(deps.served ?? servedByCli)())
        throw new ApiError(
          'this daemon was not started by metro serve, so nothing on the machine would bring it back: use the shell instead',
          400,
        );
      log.info({ path, subject: session.subject }, 'control-api: requested from the page');
      setTimeout(action.run, EXIT_DELAY_MS).unref();
      sendJson(req, res, 200, action.body);
    })
    .catch((err: unknown) => {
      if (err instanceof ApiError) apiFailure(req, res, err, 'control-api');
      else {
        log.warn({ err: errMsg(err) }, 'control-api: request failed');
        if (!res.headersSent) sendJson(req, res, 500, { error: 'control api failed' });
      }
    });
  return true;
}
