import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { gatherAccounts } from './accounts.js';
import {
  STATIONS,
  accountStationCapabilities,
} from '../stations/registry.js';
import type { Station, StationTool, ToolResult } from '../stations/types.js';
import { COMMON_TOOLS, LIST_ACCOUNTS_TOOL } from './tool-schemas.js';
import { errResult, makeCtx, okJson, toErr } from './ctx.js';
import { dispatchMessageTool } from './call-tools.js';
import { dispatchListMembers } from './member-tools.js';
import {
  dispatchAddMembers,
  dispatchCreateGroup,
  dispatchInviteLink,
  dispatchRemoveMembers,
} from './group-tools.js';
import { dispatchCreateUpload } from './upload-tool.js';
import { callTargetDenied, lineTargetDenied } from '../db/agent-scope.js';
import { SOURCE_KEYS } from '../stations/attach-resolve.js';
import { decodedLengthOf } from '../stations/attach-inline.js';
import { log } from '../daemon/log.js';
import {
  allowedAgents,
  currentIdentity,
  type RequestIdentity,
} from './request-identity.js';
import { str } from './str.js';

const STATION_TOOLS = new Map<
  string,
  { station: Station; tool: StationTool }
>();
for (const s of STATIONS)
  for (const t of s.tools) STATION_TOOLS.set(t.name, { station: s, tool: t });

const CORE_DISPATCH: Record<
  string,
  (a: Record<string, unknown>) => Promise<ToolResult>
> = {
  list_members: dispatchListMembers,
  create_group: dispatchCreateGroup,
  add_members: dispatchAddMembers,
  remove_members: dispatchRemoveMembers,
  export_invite: dispatchInviteLink,
  create_upload: dispatchCreateUpload,
};

const toolList = (): { tools: unknown[] } => ({
  tools: [
    ...COMMON_TOOLS,
    ...STATIONS.flatMap((s) =>
      s.tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    ),
    LIST_ACCOUNTS_TOOL,
  ],
});

async function handleListAccounts(
  identity: RequestIdentity | undefined,
): Promise<ToolResult> {
  try {
    return okJson({
      accounts: await gatherAccounts(allowedAgents(identity)),
      capabilities: accountStationCapabilities(),
    });
  } catch (e) {
    return errResult(`metro list_accounts failed: ${String(e)}`);
  }
}

function stationForTool(
  name: string,
  args: Record<string, unknown>,
): string | undefined {
  if (name === 'create_group') return str(args.station) || undefined;
  return STATION_TOOLS.get(name)?.station.name;
}

export function scopeDenied(
  identity: RequestIdentity | undefined,
  name: string,
  args: Record<string, unknown>,
): boolean {
  const allowed = allowedAgents(identity);
  const station = stationForTool(name, args);
  if (station !== undefined) return callTargetDenied(allowed, station, args);
  return lineTargetDenied(allowed, args);
}

const sourceOf = (entry: unknown): string => {
  const att = (entry ?? {}) as Record<string, unknown>;
  const named = SOURCE_KEYS.filter(
    (k) => typeof att[k] === 'string' && att[k] !== '',
  );
  if (named.length === 0) return 'none';
  return named
    .map((k) =>
      k === 'data' ? `data(${decodedLengthOf(String(att.data))}B)` : k,
    )
    .join('+');
};

export const attachmentShape = (
  a: Record<string, unknown>,
): string[] | undefined =>
  Array.isArray(a.attachments) ? a.attachments.map(sourceOf) : undefined;

function logToolFailure(
  name: string,
  a: Record<string, unknown>,
  result: ToolResult,
): void {
  log.warn(
    {
      tool: name,
      agents: [...allowedAgents(currentIdentity())],
      line: str(a.line),
      attachments: attachmentShape(a),
      err: result.content[0]?.text,
    },
    'mcp: tool call failed',
  );
}

async function runTool(req: {
  params: { name: string; arguments?: Record<string, unknown> };
}): Promise<ToolResult> {
  const name = req.params.name;
  const a = req.params.arguments ?? {};

  const identity = currentIdentity();
  if (name !== 'list_accounts' && scopeDenied(identity, name, a))
    return errResult('metro: this account is outside your authorized scope');

  const owned = STATION_TOOLS.get(name);
  if (owned) {
    try {
      return await owned.tool.handle(a, makeCtx(owned.station.name));
    } catch (e) {
      return toErr(name, e);
    }
  }

  const core = CORE_DISPATCH[name];
  if (core) return core(a);

  if (name === 'list_accounts') return handleListAccounts(identity);

  return dispatchMessageTool(name, a);
}

export async function callToolHandler(req: {
  params: { name: string; arguments?: Record<string, unknown> };
}): Promise<ToolResult> {
  const result = await runTool(req);
  if (result.isError === true)
    logToolFailure(req.params.name, req.params.arguments ?? {}, result);
  return result;
}

export function registerToolHandlers(server: Server): void {
  server.setRequestHandler(ListToolsRequestSchema, toolList);
  server.setRequestHandler(
    CallToolRequestSchema,
    callToolHandler as Parameters<typeof server.setRequestHandler>[1],
  );
}
