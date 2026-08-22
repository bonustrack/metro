import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleSessionApiRequest } from './session-api.js';
import { handleAgentApiRequest, type AgentApiDeps } from './agent-api.js';
import {
  handleConnectorApiRequest,
  type ConnectorApiDeps,
} from './connector-api.js';
import { handleCollectionApiRequest } from './collection-api.js';
import { handleCliPairRequest } from './cli-pair-api.js';
import {
  handleProjectApiRequest,
  type ProjectApiDeps,
} from './project-api.js';

export interface SessionApis {
  agentApi?: AgentApiDeps;
  connectorApi?: ConnectorApiDeps;
  projectApi?: ProjectApiDeps;
}

export function handleSessionApis(
  req: IncomingMessage,
  res: ServerResponse,
  apis: SessionApis,
): boolean {
  const { agentApi, connectorApi, projectApi } = apis;
  const routes: (() => boolean)[] = [() => handleSessionApiRequest(req, res)];
  if (projectApi)
    routes.push(() => handleProjectApiRequest(req, res, projectApi));
  if (connectorApi)
    routes.push(
      () => handleCliPairRequest(req, res, connectorApi),
      () => handleCollectionApiRequest(req, res, connectorApi),
      () => handleConnectorApiRequest(req, res, connectorApi),
    );
  if (agentApi) routes.push(() => handleAgentApiRequest(req, res, agentApi));
  return routes.some((run) => run());
}
