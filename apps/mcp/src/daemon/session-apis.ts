import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleSessionApiRequest } from './session-api.js';
import { handleAgentApiRequest, type AgentApiDeps } from './agent-api.js';
import {
  handleConnectorApiRequest,
  type ConnectorApiDeps,
} from './connector-api.js';
import { handleCliPairRequest } from './cli-pair-api.js';
import { handleRunApiRequest, type RunApiDeps } from './run-api.js';
import type { RelayApiDeps } from './relay.js';
import {
  handleProjectApiRequest,
  type ProjectApiDeps,
} from './project-api.js';
import {
  handleAgentConnectorRequest,
  type AgentConnectorApiDeps,
} from './agent-connector-api.js';
import type { SiweRouteDeps } from './siwe-routes.js';
import { handleImportRequest, type ImportApiDeps } from './import-api.js';
import {
  handleLocalConnectorsRequest,
  type LocalConnectorsDeps,
} from './local-connectors-api.js';
import type { ModeInfo } from './mode-api.js';

export interface SessionApis {
  agentApi?: AgentApiDeps;
  agentConnectorApi?: AgentConnectorApiDeps;
  importApi?: ImportApiDeps;
  localConnectors?: LocalConnectorsDeps;
  connectorApi?: ConnectorApiDeps;
  projectApi?: ProjectApiDeps;
  runApi?: RunApiDeps;
  relayApi?: RelayApiDeps;
  siwe?: SiweRouteDeps;
  mode?: () => ModeInfo;
}

export function handleSessionApis(
  req: IncomingMessage,
  res: ServerResponse,
  apis: SessionApis,
): boolean {
  const { agentApi, agentConnectorApi, connectorApi, projectApi, runApi, importApi } = apis;
  const { localConnectors } = apis;
  const routes: (() => boolean)[] = [() => handleSessionApiRequest(req, res)];
  if (runApi) routes.push(() => handleRunApiRequest(req, res, runApi));
  if (projectApi)
    routes.push(() => handleProjectApiRequest(req, res, projectApi));
  if (connectorApi)
    routes.push(
      () => handleCliPairRequest(req, res, connectorApi),
      () => handleConnectorApiRequest(req, res, connectorApi),
    );
  if (importApi) routes.push(() => handleImportRequest(req, res, importApi));
  if (localConnectors)
    routes.push(() => handleLocalConnectorsRequest(req, res, localConnectors));
  if (agentConnectorApi)
    routes.push(() => handleAgentConnectorRequest(req, res, agentConnectorApi));
  if (agentApi) routes.push(() => handleAgentApiRequest(req, res, agentApi));
  return routes.some((run) => run());
}
