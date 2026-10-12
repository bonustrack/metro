import type { IncomingMessage, ServerResponse } from 'node:http';
import { isRecord } from '@metro-labs/core/is-record';
import { parseId } from '@metro-labs/core/ids';
import { ApiError } from '@metro-labs/http/api-error';
import { readJsonBody, sessionRoute } from '@metro-labs/http/api-http';
import { publicOAuthResource } from '@metro-labs/http/connector-public-url';
import type { ConnectorMigrations, MigrationAction } from './migration-control.js';

const PATH = '/api/connectors/migrations';
const actions: readonly MigrationAction[] = ['move', 'prepare', 'reconcile', 'cutover', 'rollback', 'resolve'];
export type MigrationApiDeps = Pick<ConnectorMigrations, 'status' | 'run'>;

interface MigrationInput {
  sourceId: string;
  action: MigrationAction;
  scope: string;
  operationId: string | null;
  uncertainty: string | null;
  oauthResource?: string;
}

function operationOf(value: unknown): string | null {
  if (value === null) return null;
  const id = parseId(value);
  if (id === null) throw new ApiError('A migration needs its current operation ID, or null for an unprepared source.', 400);
  return id;
}

function receiptOf(body: Record<string, unknown>, action: MigrationAction): string | null {
  if (action !== 'resolve') {
    if (Object.hasOwn(body, 'uncertainty')) throw new ApiError('Only request settlement accepts an uncertainty receipt.', 400);
    return null;
  }
  if (typeof body.uncertainty !== 'string' || !/^[a-f0-9]{64}$/.test(body.uncertainty)) throw new ApiError('Confirming settled vendor requests needs the current uncertainty receipt.', 400);
  return body.uncertainty;
}

function inputOf(body: unknown): MigrationInput {
  if (!isRecord(body) || Object.keys(body).some((key) => !['scope', 'sourceId', 'action', 'operationId', 'uncertainty', 'oauthResource'].includes(key)) || typeof body.scope !== 'string' || !/^[a-f0-9]{64}$/.test(body.scope)) {
    throw new ApiError('A migration needs its connector, action and current enrollment scope.', 400);
  }
  const sourceId = parseId(body.sourceId);
  const action = actions.find((value) => value === body.action);
  if (sourceId === null || action === undefined) throw new ApiError('A migration needs a valid connector and action.', 400);
  return {
    sourceId, action, scope: body.scope, operationId: operationOf(body.operationId), uncertainty: receiptOf(body, action),
    ...(body.oauthResource === undefined ? {} : { oauthResource: publicOAuthResource(body.oauthResource) }),
  };
}

export function handleMigrationRequest(req: IncomingMessage, res: ServerResponse, deps: MigrationApiDeps): boolean {
  return sessionRoute(req, res, { methods: { [PATH]: ['GET', 'POST'] }, admin: true, label: 'connector-migration-api' }, async (session) => {
    const body = req.method === 'POST' ? await readJsonBody(req) : null;
    const current = deps.status();
    if (current.owner === null || current.owner !== session.subject) throw new ApiError('This agent belongs to another organization.', 403);
    if (req.method !== 'POST') return current;
    const { sourceId, action, scope, operationId, uncertainty, oauthResource } = inputOf(body);
    return deps.run(sourceId, action, scope, operationId, uncertainty, oauthResource);
  });
}
