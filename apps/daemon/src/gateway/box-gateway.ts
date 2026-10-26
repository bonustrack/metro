import type { IncomingMessage, ServerResponse } from 'node:http';
import { log } from '@metro-labs/core/log';
import { handleGatewayRequest, type GatewayDeps } from '@metro-labs/inference/gateway';
import { notReady, setupNotReady, type Route } from '@metro-labs/inference/model-config';
import { agentsDir } from '../agents/files.js';
import { agentIdForKey } from '../agents/keys.js';
import { reregisterMcpToken } from '../mcp-server/link.js';
import { readMcpToken } from '../mcp-server/token.js';
import { effectiveSetup } from './effective.js';
import { orgModels } from './org-models.js';
import { gatewayUrl, handleGatewayRelay } from './relay.js';

type Handler = (req: IncomingMessage, res: ServerResponse) => boolean;

const identify = (key: string): boolean => agentIdForKey(key) !== undefined;

export const routeReadiness = (route: Route): string | null => (gatewayUrl() === null ? notReady(route) : setupNotReady(route));

export const boxGateway = (): GatewayDeps => ({
  setup: () => effectiveSetup(),
  identify,
  codex: { refresh: (conn) => orgModels()?.refresh(conn) ?? Promise.resolve(null) },
});

export function boxGatewayHandler(): Handler {
  const url = gatewayUrl();
  if (url === null) {
    const deps = boxGateway();
    log.info('gateway: this box routes its model requests itself (METRO_GATEWAY_URL is empty)');
    return (req, res) => handleGatewayRequest(req, res, deps);
  }
  log.info({ url }, 'gateway: model requests go through gateway.metro.box');
  const deps = { url, identify, token: () => readMcpToken(agentsDir()), reregister: reregisterMcpToken };
  return (req, res) => handleGatewayRelay(req, res, deps);
}
