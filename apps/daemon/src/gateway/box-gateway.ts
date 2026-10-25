import type { GatewayDeps } from '@metro-labs/inference/gateway';
import { agentIdForKey } from '../agents/keys.js';
import { effectiveSetup } from './effective.js';
import { orgModels } from './org-models.js';

export const boxGateway = (): GatewayDeps => ({
  setup: () => effectiveSetup(),
  identify: (key) => agentIdForKey(key) !== undefined,
  codex: { refresh: (conn) => orgModels()?.refresh(conn) ?? Promise.resolve(null) },
});
