import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleSessionApiRequest } from './session.js';
import { handleAgentApiRequest, type AgentApiDeps } from '../agents/api.js';
import {
  handleConnectorApiRequest,
  type ConnectorApiDeps,
} from '../connectors/api.js';
import type { RelayApiDeps } from '../connectors/relay.js';
import type { IdentityRouteDeps } from './identity.js';
import { handleLocalCliRequest, type LocalCliDeps } from '../connectors/cli-api.js';
import { handleClaudeRequest, type ClaudeApiDeps } from '../claude/api.js';
import type { ModeInfo } from '@metro-labs/http/mode-api';
import { handleBundleRequest, type BundleApiDeps } from '../agents/bundle.js';
import { handleUpdateRequest, type UpdateApiDeps } from '../server/update.js';
import { handleControlRequest, type ControlApiDeps } from '../server/control.js';
import { handleMachineRequest, type MachineApiDeps } from '../server/machine.js';
import { handleModelRequest, type ModelApiDeps } from '../gateway/model-api.js';
import type { GatewayDeps } from '../gateway/gateway.js';
import { handleTerminalRequest, type TerminalApiDeps } from '../terminal/api.js';

export interface SessionApis {
  agentApi?: AgentApiDeps;
  bundleApi?: BundleApiDeps;
  updateApi?: UpdateApiDeps;
  controlApi?: ControlApiDeps;
  machineApi?: MachineApiDeps;
  modelApi?: ModelApiDeps;
  gateway?: GatewayDeps;
  terminalApi?: TerminalApiDeps;
  localCli?: LocalCliDeps;
  claudeApi?: ClaudeApiDeps;
  connectorApi?: ConnectorApiDeps;
  relayApi?: RelayApiDeps;
  identity?: IdentityRouteDeps;
  mode?: () => ModeInfo;
}

const when = <T>(dep: T | undefined, run: (dep: T) => boolean): (() => boolean)[] =>
  dep === undefined ? [] : [() => run(dep)];

export function handleSessionApis(
  req: IncomingMessage,
  res: ServerResponse,
  apis: SessionApis,
): boolean {
  const routes: (() => boolean)[] = [
    () => handleSessionApiRequest(req, res),
    ...when(apis.localCli, (d) => handleLocalCliRequest(req, res, d)),
    ...when(apis.connectorApi, (d) => handleConnectorApiRequest(req, res, d)),
    ...when(apis.bundleApi, (d) => handleBundleRequest(req, res, d)),
    ...when(apis.updateApi, (d) => handleUpdateRequest(req, res, d)),
    ...when(apis.controlApi, (d) => handleControlRequest(req, res, d)),
    ...when(apis.machineApi, (d) => handleMachineRequest(req, res, d)),
    ...when(apis.modelApi, (d) => handleModelRequest(req, res, d)),
    ...when(apis.terminalApi, (d) => handleTerminalRequest(req, res, d)),
    ...when(apis.claudeApi, (d) => handleClaudeRequest(req, res, d)),
    ...when(apis.agentApi, (d) => handleAgentApiRequest(req, res, d)),
  ];
  return routes.some((run) => run());
}
