import { errMsg, log } from '@metro-labs/core/log';
import { ApiError } from '@metro-labs/http/api-error';
import { listRemoteTools, type RemoteTool } from '@metro-labs/http/connector-tools';
import { publicTools } from '@metro-labs/connectors/catalogue';
import type { DeliveryIdentity } from '@metro-labs/connectors/db/connector-delivery';
import type { AgentConnector } from './catalog.js';
import { withCredential } from './credential.js';
import type { McpDeps } from './deps.js';
import { CallError } from './errors.js';
import type { ToolGroup } from './policy.js';

export const TOOL_LIST_TTL_MS = 5 * 60_000;

export function failureOf(err: unknown, name: string): CallError {
  if (err instanceof CallError) return err;
  if (err instanceof ApiError) return new CallError('unavailable', err.status === 429 ? err.message : `${name} could not be reached: ${err.message}`);
  log.warn({ err: errMsg(err) }, 'mcp: a connector request failed');
  return new CallError('unavailable', `Metro could not use ${name} right now. Try again in a few minutes.`);
}

export const groupsOf = (tools: RemoteTool[]): Record<string, ToolGroup> => Object.fromEntries(tools.map((tool) => [tool.name, tool.readOnly ? 'read' : 'write']));

export async function connectorTools(deps: McpDeps, identity: DeliveryIdentity, connector: AgentConnector): Promise<RemoteTool[]> {
  const cached = deps.tools.get(connector.id);
  if (cached !== undefined) return cached;
  return deps.listings.run(connector.id, async () => {
    try {
      const tools = await withCredential(deps, identity, connector.id, async (target) => publicTools(await listRemoteTools(target.url, target.auth, deps.fetch), target.secret));
      deps.tools.set(connector.id, tools);
      return tools;
    } catch (err) {
      throw failureOf(err, connector.name);
    }
  });
}
