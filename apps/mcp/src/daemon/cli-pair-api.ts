import type { IncomingMessage, ServerResponse } from 'node:http';
import { errMsg, log } from './log.js';
import { apiSession, bodyField, cors, readJsonBody, sendJson } from './api-http.js';
import { CLI_CODE_RE, mintCliCode, takeCliCode } from './cli-pair.js';
import { sessionTtlFromEnv } from './google-oauth.js';
import { signSession } from './session.js';

const CODE_PATH = '/api/cli/code';
const CLAIM_PATH = '/api/cli/claim';

function handleMint(req: IncomingMessage, res: ServerResponse): void {
  const session = apiSession(req);
  if (!session) {
    sendJson(req, res, 401, { error: 'unauthorized' });
    return;
  }
  const { code, expiresAt } = mintCliCode(session.email);
  log.info({ email: session.email }, 'cli-pair: code minted');
  sendJson(req, res, 200, { code, expiresAt });
}

async function handleClaim(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const secret = process.env.METRO_SESSION_SECRET?.trim() ?? '';
  if (secret === '') {
    sendJson(req, res, 503, { error: 'sign-in is not configured' });
    return;
  }
  const code = bodyField(await readJsonBody(req), 'code');
  const email =
    typeof code === 'string' && CLI_CODE_RE.test(code)
      ? takeCliCode(code)
      : undefined;
  if (email === undefined) {
    sendJson(req, res, 400, { error: 'that code has expired or was already used' });
    return;
  }
  const session = signSession({ email, agentIds: [], via: 'cli' }, secret, {
    ttlSec: sessionTtlFromEnv(),
  });
  log.info({ email }, 'cli-pair: code claimed');
  sendJson(req, res, 200, { session, email });
}

export function handleCliPairRequest(
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  const path = (req.url ?? '').split('?')[0] ?? '';
  if (path !== CODE_PATH && path !== CLAIM_PATH) {
    if (!path.startsWith('/api/cli/') && path !== '/api/cli') return false;
    sendJson(req, res, 404, { error: 'no such route' });
    return true;
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors(req)).end();
    return true;
  }
  if (req.method !== 'POST') {
    sendJson(req, res, 405, { error: 'method not allowed' });
    return true;
  }
  if (path === CODE_PATH) {
    handleMint(req, res);
    return true;
  }
  handleClaim(req, res).catch((err: unknown) => {
    log.warn({ err: errMsg(err) }, 'cli-pair: unhandled error');
    if (!res.headersSent) sendJson(req, res, 500, { error: 'cli pairing failed' });
  });
  return true;
}
