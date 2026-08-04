import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { gatherAccounts } from './accounts.js';
import {
  STATIONS,
  accountStationNames,
  accountStationCapabilities,
} from '../stations/registry.js';
import type { Station, StationTool, ToolResult } from '../stations/types.js';
import {
  COMMON_TOOLS,
  LIST_ACCOUNTS_TOOL,
  MCP_INSTRUCTIONS,
} from './tool-schemas.js';
import { errResult, makeCtx, okJson, toErr } from './ctx.js';
import { dispatchMessageTool } from './call-tools.js';
import { dispatchListMembers } from './member-tools.js';
import {
  dispatchAddMembers,
  dispatchCreateGroup,
  dispatchInviteLink,
  dispatchRemoveMembers,
} from './group-tools.js';
import { BodyTooLargeError } from '../daemon/http.js';
import { InboundRelay } from '../channels/inbound.js';
import {
  allowlistForLine,
  senderMatchesAllowlist,
} from '../db/agent-map.js';
import { callTargetDenied, lineTargetDenied } from '../db/agent-scope.js';
import {
  allowedAgents,
  authConfigFromEnv,
  authenticate,
  currentIdentity,
  runWithIdentity,
  type RequestIdentity,
} from './request-identity.js';
import { ChannelRelay } from '../channels/relay.js';
import { ChannelOwner } from './channel-owner.js';
import { registerPermissionRelay } from './permission-relay.js';
import { BoundedEventStore } from './event-store.js';
import { str } from './str.js';
import { isStandaloneGet, type RawGetSink } from './raw-get-stream.js';
import { serveChannelGet } from './channel-get.js';

const parseList = (raw: string, lower: boolean): string[] =>
  raw
    .split(',')
    .map((s) => (lower ? s.trim().toLowerCase() : s.trim()))
    .filter(Boolean);
const getStations = (): Set<string> =>
  new Set(
    parseList(
      process.env.METRO_CHANNEL_STATIONS ?? accountStationNames().join(','),
      false,
    ),
  );
const log = (...a: unknown[]): void => {
  console.error('[metro-mcp]', ...a);
};

const mcp = new Server(
  { name: 'metro', version: '0.1.0' },
  {
    capabilities: {
      experimental: {
        'claude/channel': {},
        'claude/channel/permission': {},
      },
      tools: {},
    },
    instructions: MCP_INSTRUCTIONS,
  },
);

const channelOwner = new ChannelOwner();

mcp.setRequestHandler(ListToolsRequestSchema, () => ({
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
}));

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
};

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

function scopeDenied(
  identity: RequestIdentity | undefined,
  name: string,
  args: Record<string, unknown>,
): boolean {
  const allowed = allowedAgents(identity);
  const station = stationForTool(name, args);
  if (station !== undefined) return callTargetDenied(allowed, station, args);
  return lineTargetDenied(allowed, args);
}

async function callToolHandler(req: {
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
mcp.setRequestHandler(
  CallToolRequestSchema,
  callToolHandler as Parameters<typeof mcp.setRequestHandler>[1],
);

const senderAllowed = (from: string, line: string): boolean => {
  const allowlist = allowlistForLine(line);
  return allowlist ? senderMatchesAllowlist(allowlist, from) : true;
};

const relay = new InboundRelay({
  mcp,
  log,
  getStations,
  senderAllowed,
});

registerPermissionRelay({ mcp, relay, owner: channelOwner, log });

interface AdoptableInner {
  sessionId?: string;
  _initialized?: boolean;
}

function makeTransport(
  eventStore: BoundedEventStore,
  adoptId?: string,
): StreamableHTTPServerTransport {
  const t = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    eventStore,
  });
  if (adoptId !== undefined) {
    const inner = (t as unknown as { _webStandardTransport?: AdoptableInner })
      ._webStandardTransport;
    if (inner) {
      inner.sessionId = adoptId;
      inner._initialized = true;
    }
  }
  return t;
}

const isInitialize = (b: unknown): boolean =>
  !!b &&
  typeof b === 'object' &&
  (b as { method?: string }).method === 'initialize';

export interface RebindDecision {
  rebind: boolean;
  adoptId?: string;
}

export function rebindDecision(input: {
  isInitialize: boolean;
  presented: string | undefined;
  current: string | undefined;
  adopted: string | undefined;
}): RebindDecision {
  if (input.isInitialize) return { rebind: true };
  const { presented, current, adopted } = input;
  if (presented !== undefined && presented !== current && presented !== adopted)
    return { rebind: true, adoptId: presented };
  return { rebind: false };
}

const headerSessionId = (req: IncomingMessage): string | undefined => {
  const raw = req.headers['mcp-session-id'];
  if (Array.isArray(raw)) return raw[0];
  return typeof raw === 'string' ? raw : undefined;
};

const MCP_BODY_MAX = 32 * 1024 * 1024;

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    const buf = c as Buffer;
    total += buf.length;
    if (total > MCP_BODY_MAX) throw new BodyTooLargeError(MCP_BODY_MAX);
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return raw ? JSON.parse(raw) : undefined;
  } catch {
    return undefined;
  }
}

type ParsedBody = { ok: true; body: unknown } | { ok: false };

async function readOrReject(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<ParsedBody> {
  try {
    const body = req.method === 'POST' ? await readBody(req) : undefined;
    return { ok: true, body };
  } catch (err) {
    if (!(err instanceof BodyTooLargeError)) throw err;
    res.writeHead(413).end('payload too large');
    return { ok: false };
  }
}

export async function createMetroMcp(): Promise<{
  httpHandler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  startInbound: () => void;
}> {
  const eventStore = new BoundedEventStore();
  let transport = makeTransport(eventStore);
  if ((mcp as { transport?: unknown }).transport !== undefined)
    await mcp.close().catch(() => undefined);
  await mcp.connect(transport);
  const channel = new ChannelRelay({
    relay,
    log,
    inScope: (line) => channelOwner.inScope(line),
  });
  let adoptedSessionId: string | undefined;
  let rawGetSink: RawGetSink | undefined;
  const dropStream = (): void => {
    if (rawGetSink) rawGetSink.closed = true;
    rawGetSink = undefined;
    channelOwner.releaseStream();
  };
  const rebind = async (
    identity: RequestIdentity,
    adoptId?: string,
  ): Promise<void> => {
    const keepStream = channelOwner.streamBelongsTo(identity);
    if (!keepStream) dropStream();
    await transport.close().catch(() => undefined);
    transport = makeTransport(eventStore, adoptId);
    await mcp.connect(transport);
    adoptedSessionId = adoptId;
    if (rawGetSink && !rawGetSink.closed) rawGetSink.attach(transport);
    channel.replayMissed();
  };
  const currentSessionId = (): string | undefined => {
    const id = (transport as { sessionId?: unknown }).sessionId;
    return typeof id === 'string' ? id : undefined;
  };

  const syncSession = async (
    req: IncomingMessage,
    body: unknown,
    identity: RequestIdentity,
  ): Promise<void> => {
    const decision = rebindDecision({
      isInitialize: isInitialize(body),
      presented: headerSessionId(req),
      current: currentSessionId(),
      adopted: adoptedSessionId,
    });
    if (decision.rebind) await rebind(identity, decision.adoptId);
  };
  const serveGet = async (
    req: IncomingMessage,
    res: ServerResponse,
    identity: RequestIdentity,
  ): Promise<void> => {
    const served = await serveChannelGet({
      transport,
      eventStore,
      req,
      res,
      previous: rawGetSink,
      log,
      registerSink: (sink) => {
        rawGetSink = sink;
        if (sink === undefined) channelOwner.releaseStream();
        else channelOwner.bindStream(identity);
      },
    });
    if (served) channel.replayMissed();
  };
  const httpHandler = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    const identity = authenticate(req, authConfigFromEnv());
    if (!identity) {
      res.writeHead(401).end('unauthorized');
      return;
    }
    const parsed = await readOrReject(req, res);
    if (!parsed.ok) return;
    await runWithIdentity(identity, async () => {
      await syncSession(req, parsed.body, identity);
      if (isStandaloneGet(req)) {
        await serveGet(req, res, identity);
        return;
      }
      await transport.handleRequest(req, res, parsed.body);
    });
  };

  const startInbound = (): void => {
    channel.start();
    log('inbound: subscribed to in-process event bus (bounded replay on reconnect)');
  };

  return { httpHandler, startInbound };
}
