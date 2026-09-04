import type { IncomingMessage, ServerResponse } from 'node:http';
import { errMsg, log } from './log.js';
import {
  apiFailure,
  apiSession,
  bodyField,
  cors,
  readJsonBody,
  sendJson,
} from './api-http.js';
import { parsePairingCode } from './agent-import.js';
import type { CreatedAgent } from '../db/agent-admin.js';

const PATH = '/api/agents/import';

export interface ImportedAgent extends CreatedAgent {
  stations: number;
  connectors: number;
}

export interface ImportApiDeps {
  importAgent: (subject: string, code: string) => Promise<ImportedAgent>;
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ImportApiDeps,
  subject: string,
): Promise<void> {
  try {
    const code = parsePairingCode(bodyField(await readJsonBody(req), 'code'));
    const made = await deps.importAgent(subject, code);
    log.info(
      { agent: made.name, id: made.id, stations: made.stations, connectors: made.connectors },
      'import-api: agent imported from metro',
    );
    sendJson(req, res, 201, made);
  } catch (err) {
    apiFailure(req, res, err, 'import-api');
  }
}

export function handleImportRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ImportApiDeps,
): boolean {
  if ((req.url ?? '').split('?')[0] !== PATH) return false;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors(req)).end();
    return true;
  }
  if (req.method !== 'POST') {
    sendJson(req, res, 405, { error: 'method not allowed' });
    return true;
  }
  const session = apiSession(req);
  if (!session) {
    sendJson(req, res, 401, { error: 'unauthorized' });
    return true;
  }
  handle(req, res, deps, session.subject).catch((err: unknown) => {
    log.warn({ err: errMsg(err) }, 'import-api: unhandled error');
    if (!res.headersSent) sendJson(req, res, 500, { error: 'import failed' });
  });
  return true;
}
