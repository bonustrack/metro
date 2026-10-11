import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ConnectorSyncStatus } from '@metro-labs/core/connector-sync';
import { isRecord } from '@metro-labs/core/is-record';
import { ApiError } from '@metro-labs/http/api-error';
import { readJsonBody, sessionRoute } from '@metro-labs/http/api-http';

const PATH = '/api/connectors/sync';

export interface ConnectorSyncApiDeps {
  status: () => ConnectorSyncStatus;
  set: (enabled: boolean, scope: string) => ConnectorSyncStatus;
}

export function handleConnectorSyncRequest(req: IncomingMessage, res: ServerResponse, deps: ConnectorSyncApiDeps): boolean {
  return sessionRoute(req, res, { methods: { [PATH]: ['GET', 'PUT'] }, admin: true, label: 'connector-sync-api' }, async (session) => {
    const body = req.method === 'PUT' ? await readJsonBody(req) : null;
    const current = deps.status();
    if (current.owner === null || current.owner !== session.subject) throw new ApiError('This agent belongs to another organization.', 403);
    if (req.method !== 'PUT') return current;
    if (!isRecord(body) || typeof body.enabled !== 'boolean' || typeof body.scope !== 'string' || !/^[a-f0-9]{64}$/.test(body.scope) || Object.keys(body).some((key) => key !== 'enabled' && key !== 'scope')) {
      throw new ApiError('Sync needs an enabled flag and the current enrollment scope.', 400);
    }
    return deps.set(body.enabled, body.scope);
  });
}
