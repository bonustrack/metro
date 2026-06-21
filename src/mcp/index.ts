import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  drainTail,
  followTail,
  historySize,
  type TailOpts,
} from '../broker/history-stream.js';
import { gatherAccounts } from '../monitor-api.js';
import type { HistoryEntry } from '../history.js';
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
import { InboundRelay } from './inbound.js';

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
  metroSend,
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
    relay.registerPermission(params.request_id, line);
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

function makeTransport(): StreamableHTTPServerTransport {
  return new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
}

const isInitialize = (b: unknown): boolean =>
  !!b &&
  typeof b === 'object' &&
  (b as { method?: string }).method === 'initialize';

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
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
  let transport = makeTransport();
  await mcp.connect(transport);
  const reconnect = async (): Promise<void> => {
    await transport.close().catch(() => undefined);
    transport = makeTransport();
    await mcp.connect(transport);
  };

  const httpToken = process.env.METRO_MCP_HTTP_TOKEN ?? '';
  const tokenEq = (given: string): boolean => {
    const g = Buffer.from(given);
    const w = Buffer.from(httpToken);
    return g.length === w.length && timingSafeEqual(g, w);
  };
  const httpHandler = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    if (httpToken) {
      const qt = new URL(req.url ?? '/', 'http://localhost').searchParams.get(
        'token',
      );
      if (qt == null || !tokenEq(qt)) {
        res.writeHead(401).end('unauthorized');
        return;
      }
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      if (isInitialize(body)) await reconnect();
      await transport.handleRequest(req, res, body);
      return;
    }
    await transport.handleRequest(req, res);
  };

  const startInbound = (): void => {
    const opts: TailOpts = { mode: 'all', self: null };
    const onEntry = (e: HistoryEntry): void => {
      void relay
        .handleEvent(e as unknown as Record<string, unknown>)
        .catch((err: unknown) => {
          log('event err', err);
        });
    };
    const offset = drainTail(historySize(), opts, onEntry);
    followTail(offset, opts, onEntry, 1_000);
    log('inbound: following history tail (mode=all)');
  };

  return { httpHandler, startInbound };
}
