import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { z } from 'zod';
import type { InboundRelay } from '../channels/inbound.js';
import { cancelPrompt, holdPrompt, type Behavior } from '../approvals/pending.js';
import { approversForLine, lineReceives } from '../agents/map.js';
import { metroCall } from './ctx.js';
import { promptBody } from './permission-prompt.js';
import { permissionCall } from './call-permission.js';

const PermissionRequestSchema = z.object({
  method: z.literal('notifications/claude/channel/permission_request'),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
    call: z.unknown().optional(),
  }),
});

type PermissionRequest = z.infer<typeof PermissionRequestSchema>;

const trainOf = (line: string): string => line.split('/')[2] ?? '';

async function metroSend(line: string, text: string): Promise<void> {
  await metroCall(trainOf(line), 'send', { line, text });
}

export interface PermissionRelayDeps {
  mcp: Server;
  relay: InboundRelay;
  inScope: (line: string) => boolean;
  live: () => boolean;
  log: (...a: unknown[]) => void;
}

function relayLine(deps: PermissionRelayDeps, requestId: string, callLine?: string): string | undefined {
  if (!deps.live()) {
    deps.log('permission_request: live events are off, so no chat answer can arrive; held for the page only', requestId);
    return undefined;
  }
  const line = callLine ?? deps.relay.knownLine;
  if (!line) {
    deps.log('permission_request: no known line, held for the page only', requestId);
    return undefined;
  }
  if (!deps.inScope(line)) {
    deps.log('permission_request: known line is outside the agent scope, held for the page only', requestId);
    return undefined;
  }
  if (!lineReceives(line)) {
    deps.log('permission_request: the known chat does not receive messages now, so no answer can arrive; held for the page only', requestId);
    return undefined;
  }
  if (approversForLine(line).length === 0) {
    deps.log('permission_request: nobody on that chat may approve, held for the page only', requestId);
    return undefined;
  }
  return line;
}

export function registerPermissionRelay(deps: PermissionRelayDeps): void {
  const { mcp, log } = deps;
  mcp.setNotificationHandler(z.object({ method: z.literal('notifications/metro/permission_cancel'), params: z.object({ request_id: z.string() }) }), (notice) => {
    cancelPrompt(notice.params.request_id, mcp);
  });
  const answer = (requestId: string) => async (behavior: Behavior): Promise<void> => {
    await mcp.notification({ method: 'notifications/claude/channel/permission', params: { request_id: requestId, behavior } });
  };
  mcp.setNotificationHandler(PermissionRequestSchema as never, async (n: PermissionRequest) => {
    const { params } = n;
    const call = permissionCall(params, deps.inScope);
    if (call === null) {
      await answer(params.request_id)('deny');
      return;
    }
    const line = relayLine(deps, params.request_id, call?.route.line);
    holdPrompt(
      {
        requestId: params.request_id,
        tool: params.tool_name,
        description: params.description,
        preview: params.input_preview,
        line,
        at: Date.now(),
        ...(call === undefined ? {} : { call }),
      },
      mcp,
      answer(params.request_id),
      line === undefined ? undefined : async (text) => metroSend(line, text),
    );
    if (line === undefined) return;
    try {
      await metroSend(line, promptBody(params));
    } catch (e) {
      log('relay send failed', e);
    }
  });
}
