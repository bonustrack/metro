import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
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
import { errResult, makeCtx, metroCall, okJson, toErr } from './ctx.js';
import { dispatchMessageTool } from './call-tools.js';
import { BodyTooLargeError } from '../daemon/http.js';
import { InboundRelay } from '../channels/inbound.js';
import { ChannelRelay } from '../channels/relay.js';
import { BoundedEventStore } from './event-store.js';
import {
  isStandaloneGet,
  serveStandaloneGet,
  validateStandaloneSession,
  type RawGetSink,
} from './raw-get-stream.js';

const ALLOWLIST_DEFAULT =
  'bee7314f7127ef53b4e3bf5256e54b0a1acdc3698d064fb1029bd8f83ecc1186';
const parseList = (raw: string, lower: boolean): string[] =>
  raw
    .split(',')
    .map((s) => (lower ? s.trim().toLowerCase() : s.trim()))
    .filter(Boolean);
const getAllowlist = (): string[] =>
  parseList(process.env.METRO_CHANNEL_ALLOWLIST ?? ALLOWLIST_DEFAULT, true);
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

const trainOf = (line: string): string => line.split('/')[2] ?? '';

async function metroSend(
  line: string,
  text: string,
  replyTo?: string,
): Promise<void> {
  const args: Record<string, string> = { line, text };
  if (replyTo) args.replyTo = replyTo;
  await metroCall(trainOf(line), 'send', args);
}

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

async function callToolHandler(req: {
  params: { name: string; arguments?: Record<string, unknown> };
}): Promise<ToolResult> {
  const name = req.params.name;
  const a = req.params.arguments ?? {};

  const owned = STATION_TOOLS.get(name);
  if (owned) {
    try {
      return await owned.tool.handle(a, makeCtx(owned.station.name));
    } catch (e) {
      return toErr(name, e);
    }
  }

  if (name === 'list_accounts') {
    try {
      return okJson({
        accounts: await gatherAccounts(),
        capabilities: accountStationCapabilities(),
      });
    } catch (e) {
      return errResult(`metro list_accounts failed: ${String(e)}`);
    }
  }

  return dispatchMessageTool(name, a);
}
mcp.setRequestHandler(
  CallToolRequestSchema,
  callToolHandler as Parameters<typeof mcp.setRequestHandler>[1],
);

const senderAllowed = (from: string): boolean => {
  const allowlist = getAllowlist();
  if (allowlist.includes('*')) return true;
  const f = (from ?? '').toLowerCase();
  const id = f.split('/').pop() ?? f;
  return allowlist.some((a) => a === f || a === id);
};

const relay = new InboundRelay({
  mcp,
  log,
  getStations,
  senderAllowed,
});

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
mcp.setNotificationHandler(
  PermissionRequestSchema as never,
  async (n: PermissionRequest) => {
    const { params } = n;
    const line = relay.knownLine;
    if (!line) {
      log('permission_request but no known line to relay to', params.request_id);
      return;
    }
    relay.registerPermission(params.request_id);
    const body =
      `Claude wants to run ${params.tool_name}: ${params.description}\n` +
      (params.input_preview ? `\n${params.input_preview}\n` : '') +
      `\nReply "yes ${params.request_id}" or "no ${params.request_id}"`;
    try {
      await metroSend(line, body);
    } catch (e) {
      log('relay send failed', e);
    }
  },
);

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

export async function createMetroMcp(): Promise<{
  httpHandler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  startInbound: () => void;
}> {
  const eventStore = new BoundedEventStore();
  let transport = makeTransport(eventStore);
  if ((mcp as { transport?: unknown }).transport !== undefined)
    await mcp.close().catch(() => undefined);
  await mcp.connect(transport);
  const channel = new ChannelRelay({ relay, log });
  let adoptedSessionId: string | undefined;
  let rawGetSink: RawGetSink | undefined;
  const rebind = async (adoptId?: string): Promise<void> => {
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

  const httpToken = process.env.METRO_MCP_HTTP_TOKEN ?? '';
  const tokenEq = (given: string): boolean => {
    const g = Buffer.from(given);
    const w = Buffer.from(httpToken);
    return g.length === w.length && timingSafeEqual(g, w);
  };
  const authorized = (req: IncomingMessage): boolean => {
    if (!httpToken) return true;
    const qt = new URL(req.url ?? '/', 'http://localhost').searchParams.get(
      'token',
    );
    return qt != null && tokenEq(qt);
  };
  const syncSession = async (
    req: IncomingMessage,
    body: unknown,
  ): Promise<void> => {
    const decision = rebindDecision({
      isInitialize: isInitialize(body),
      presented: headerSessionId(req),
      current: currentSessionId(),
      adopted: adoptedSessionId,
    });
    if (decision.rebind) await rebind(decision.adoptId);
  };
  const serveGet = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    const check = validateStandaloneSession(transport, req);
    if (!check.ok) {
      res.writeHead(check.status ?? 400).end(check.message ?? 'bad request');
      return;
    }
    if (rawGetSink && !rawGetSink.closed) rawGetSink.closed = true;
    await serveStandaloneGet({
      transport,
      eventStore,
      req,
      res,
      log,
      registerSink: (sink) => {
        rawGetSink = sink;
      },
    });
  };
  const httpHandler = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    if (!authorized(req)) {
      res.writeHead(401).end('unauthorized');
      return;
    }
    let body: unknown;
    try {
      body = req.method === 'POST' ? await readBody(req) : undefined;
    } catch (err) {
      if (!(err instanceof BodyTooLargeError)) throw err;
      res.writeHead(413).end('payload too large');
      return;
    }
    await syncSession(req, body);
    if (isStandaloneGet(req)) {
      await serveGet(req, res);
      return;
    }
    await transport.handleRequest(req, res, body);
  };

  const startInbound = (): void => {
    channel.start();
    log('inbound: subscribed to in-process event bus (bounded replay on reconnect)');
  };

  return { httpHandler, startInbound };
}
