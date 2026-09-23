import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApiError } from '@metro-labs/http/api-error';
import { sessionRoute } from '@metro-labs/http/api-http';
import { log } from '@metro-labs/core/log';

const STOP = '/api/stop';
const RESTART = '/api/restart';
const EXIT_DELAY_MS = 500;

export interface ControlApiDeps {
  restart: () => void;
  stop: () => void;
  served?: () => boolean;
}

interface Action {
  run: () => void;
  body: Record<string, boolean>;
}

const servedByCli = (): boolean => (process.env.METRO_CLI_BIN?.trim() ?? '') !== '';

function actionFor(path: string, deps: ControlApiDeps): Action {
  return path === STOP ? { run: deps.stop, body: { stopping: true } } : { run: deps.restart, body: { restarting: true } };
}

export function handleControlRequest(req: IncomingMessage, res: ServerResponse, deps: ControlApiDeps): boolean {
  return sessionRoute(req, res, { methods: { [STOP]: ['POST'], [RESTART]: ['POST'] }, admin: true, label: 'control-api' }, async (session, path) => {
    const action = actionFor(path, deps);
    if (!(deps.served ?? servedByCli)())
      throw new ApiError(
        'this daemon was not started by metro serve, so nothing on the machine would bring it back: use the shell instead',
        400,
      );
    log.info({ path, subject: session.subject }, 'control-api: requested from the page');
    setTimeout(action.run, EXIT_DELAY_MS).unref();
    return Promise.resolve(action.body);
  });
}
