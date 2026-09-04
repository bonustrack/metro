import type { IncomingMessage, ServerResponse } from 'node:http';
import { errMsg, log } from './log.js';
import { apiSession, cors, sendJson } from './api-http.js';
import type { HostedConnector } from './hosted-connectors.js';

const PATH = '/api/connectors';

export interface LocalConnectorsDeps {
  listConnectors: (subject: string) => Promise<HostedConnector[]>;
}

const payload = (c: HostedConnector): Record<string, unknown> => ({
  id: c.id,
  name: c.name,
  url: c.url,
  transport: c.transport,
  auth: c.signIn === null ? 'none' : 'oauth',
  header: null,
  signIn: c.signIn,
  verified: null,
  managed: 'metro.box',
});

export function handleLocalConnectorsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: LocalConnectorsDeps,
): boolean {
  const path = (req.url ?? '').split('?')[0] ?? '';
  if (path !== PATH && !path.startsWith(`${PATH}/`)) return false;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors(req)).end();
    return true;
  }
  if (path !== PATH || req.method !== 'GET') {
    sendJson(req, res, path === PATH ? 405 : 404, {
      error: 'connectors are managed on metro.box, not on a local daemon',
    });
    return true;
  }
  const session = apiSession(req);
  if (!session) {
    sendJson(req, res, 401, { error: 'unauthorized' });
    return true;
  }
  deps
    .listConnectors(session.subject)
    .then((list) => {
      sendJson(req, res, 200, { connectors: list.map(payload) });
    })
    .catch((err: unknown) => {
      log.warn({ err: errMsg(err) }, 'local connectors: request failed');
      if (!res.headersSent) sendJson(req, res, 500, { error: 'connectors failed' });
    });
  return true;
}
