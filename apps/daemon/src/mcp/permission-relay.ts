import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { z } from 'zod';
import type { InboundRelay } from '../channels/inbound.js';
import type { ChannelOwner } from './channel-owner.js';
import { metroCall } from './ctx.js';

const PermissionRequestSchema = z.object({
  method: z.literal('notifications/claude/channel/permission_request'),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
});

type PermissionRequest = z.infer<typeof PermissionRequestSchema>;

const trainOf = (line: string): string => line.split('/')[2] ?? '';

async function metroSend(line: string, text: string): Promise<void> {
  await metroCall(trainOf(line), 'send', { line, text });
}

function promptBody(params: PermissionRequest['params']): string {
  return (
    `Claude wants to run ${params.tool_name}: ${params.description}\n` +
    (params.input_preview ? `\n${params.input_preview}\n` : '') +
    `\nReply "yes ${params.request_id}" or "no ${params.request_id}"`
  );
}

export interface PermissionRelayDeps {
  mcp: Server;
  relay: InboundRelay;
  owner: ChannelOwner;
  log: (...a: unknown[]) => void;
}

export function registerPermissionRelay(deps: PermissionRelayDeps): void {
  const { mcp, relay, owner, log } = deps;
  mcp.setNotificationHandler(
    PermissionRequestSchema as never,
    async (n: PermissionRequest) => {
      const { params } = n;
      const line = relay.knownLine;
      if (!line) {
        log('permission_request but no known line to relay to', params.request_id);
        return;
      }
      if (!owner.inScope(line)) {
        log(
          'permission_request: known line is outside the channel session scope',
          params.request_id,
        );
        return;
      }
      relay.registerPermission(params.request_id);
      try {
        await metroSend(line, promptBody(params));
      } catch (e) {
        log('relay send failed', e);
      }
    },
  );
}
