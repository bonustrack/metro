import { execFile } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { errMsg, log } from './log.js';
import { ApiError } from './api-error.js';
import { apiFailure, apiSession, cors, sendJson } from './api-http.js';
import { isRecord } from './is-record.js';
import { METRO_VERSION } from './version.js';

const PATH = '/api/update';
const CHECK_TTL_MS = 10 * 60_000;
const CHECK_TIMEOUT_MS = 30_000;
const UPDATE_TIMEOUT_MS = 5 * 60_000;
const RESTART_DELAY_MS = 500;
const OUTPUT_TAIL = 800;

export interface UpdateCheck {
  current: string;
  latest: string;
  newer: boolean;
}

export interface UpdateResult {
  updated: boolean;
  version: string;
  restarting: boolean;
}

export interface UpdateApiDeps {
  authorize: (subject: string) => void;
  restart: () => void;
  cliBin?: () => string;
}

const cliBinFromEnv = (): string => process.env.METRO_CLI_BIN?.trim() ?? '';

function runCli(bin: string, args: string[], timeout: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [bin, ...args], { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err === null) resolve({ stdout, stderr });
      else reject(new ApiError(`metro update failed: ${(stderr || err.message).trim().slice(-OUTPUT_TAIL)}`, 502));
    });
  });
}

let cached: { at: number; check: UpdateCheck } | null = null;

function parseCheck(raw: string): UpdateCheck {
  let body: unknown;
  try {
    body = JSON.parse(raw.trim().split('\n').at(-1) ?? '');
  } catch {
    throw new ApiError('metro update --check returned no report', 502);
  }
  if (!isRecord(body) || typeof body.current !== 'string' || typeof body.latest !== 'string')
    throw new ApiError('metro update --check returned an unexpected report', 502);
  return { current: body.current, latest: body.latest, newer: body.newer === true };
}

async function check(bin: string, now = Date.now()): Promise<UpdateCheck> {
  if (cached !== null && now - cached.at < CHECK_TTL_MS) return cached.check;
  const out = await runCli(bin, ['update', '--check'], CHECK_TIMEOUT_MS);
  cached = { at: now, check: parseCheck(out.stdout) };
  return cached.check;
}

async function apply(bin: string, deps: UpdateApiDeps): Promise<UpdateResult> {
  const before = await check(bin);
  if (!before.newer) return { updated: false, version: before.current, restarting: false };
  const out = await runCli(bin, ['update'], UPDATE_TIMEOUT_MS);
  cached = null;
  log.info({ from: before.current, to: before.latest, output: out.stderr.trim().slice(-OUTPUT_TAIL) }, 'update-api: metro updated, restarting');
  setTimeout(() => {
    deps.restart();
  }, RESTART_DELAY_MS).unref();
  return { updated: true, version: before.latest, restarting: true };
}

function binOrThrow(deps: UpdateApiDeps): string {
  const bin = (deps.cliBin ?? cliBinFromEnv)();
  if (bin === '')
    throw new ApiError('this daemon was not started by metro serve, so it cannot update itself: run metro update on the machine', 400);
  return bin;
}

export function handleUpdateRequest(req: IncomingMessage, res: ServerResponse, deps: UpdateApiDeps): boolean {
  const path = (req.url ?? '').split('?')[0] ?? '';
  if (path !== PATH) return false;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors(req)).end();
    return true;
  }
  if (req.method !== 'GET' && req.method !== 'POST') {
    sendJson(req, res, 405, { error: 'method not allowed' });
    return true;
  }
  const session = apiSession(req);
  if (!session) {
    sendJson(req, res, 401, { error: 'unauthorized' });
    return true;
  }
  Promise.resolve()
    .then(async (): Promise<unknown> => {
      deps.authorize(session.subject);
      const bin = binOrThrow(deps);
      if (req.method === 'GET') return { ...(await check(bin)), running: METRO_VERSION };
      return apply(bin, deps);
    })
    .then((body) => {
      sendJson(req, res, 200, body);
    })
    .catch((err: unknown) => {
      if (err instanceof ApiError) apiFailure(req, res, err, 'update-api');
      else {
        log.warn({ err: errMsg(err) }, 'update-api: request failed');
        if (!res.headersSent) sendJson(req, res, 500, { error: 'update api failed' });
      }
    });
  return true;
}
