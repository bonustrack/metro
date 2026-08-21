import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { Line } from '../stations/lines.js';
import { errMsg, log } from './log.js';
import {
  classifyEvent,
  formatDisplay,
  mintId,
  publishEvent,
  userSelf,
  type MetroEvent,
} from './events.js';
import type { TrainEvent } from './protocol.js';
import { agentForLine, agentIdForLine } from '../db/agent-map.js';
import {
  findEndpointByWebhookId,
  listEndpoints,
  tokenMatches,
  webhookPort,
  type Endpoint,
} from './tunnel.js';
import { attachmentEventUrl, handleAttachRequest } from './attach-serve.js';
import { webhookEntry } from '@metro-labs/webhook';
import { handleGoogleAuthRequest } from './google-oauth.js';
import { handleAgentApiRequest, type AgentApiDeps } from './agent-api.js';
import {
  handleConnectorApiRequest,
  type ConnectorApiDeps,
} from './connector-api.js';
import { handleUploadRequest } from './upload-api.js';
import {
  handleMonitorRequest,
  type MonitorCall,
} from '../monitor/api.js';
import { applyMcpCors, handleMcpPreflight } from './cors.js';

const LRU_CAP = 2_000;

const METRO_VERSION = process.env.npm_package_version ?? '0.1.0-beta.15';

function dedupKey(
  e: Pick<MetroEvent, 'station' | 'line' | 'messageId'>,
): string | null {
  if (!e.messageId) return null;
  return `${e.station} ${e.line} ${e.messageId}`;
}

export interface DedupSeq {
  admit(entry: MetroEvent): number | null;
}

export function makeDedupSeq(): DedupSeq {
  const seen = new Map<string, true>();
  const seqByLine = new Map<string, number>();

  log.info('dedup+seq: live-from-boot (no persisted seed)');

  const isInbound = (e: MetroEvent): boolean => !Line.isLocal(e.from);

  return {
    admit(entry: MetroEvent): number | null {
      const key = dedupKey(entry);
      if (key && isInbound(entry)) {
        if (seen.has(key)) {
          log.debug(
            {
              station: entry.station,
              line: entry.line,
              messageId: entry.messageId,
            },
            'dedup: dropped duplicate inbound message',
          );
          return null;
        }
        seen.set(key, true);
        while (seen.size > LRU_CAP) {
          const oldest = seen.keys().next();
          if (oldest.done) break;
          seen.delete(oldest.value);
        }
      }
      const next = (seqByLine.get(entry.line) ?? 0) + 1;
      seqByLine.set(entry.line, next);
      while (seqByLine.size > LRU_CAP) {
        const oldest = seqByLine.keys().next();
        if (oldest.done) break;
        seqByLine.delete(oldest.value);
      }
      return next;
    },
  };
}

function withAttachmentUrl(entry: MetroEvent): MetroEvent {
  const payload = entry.payload;
  if (!payload || typeof payload !== 'object') return entry;
  const agentId = agentIdForLine(entry.line);
  if (agentId === undefined) return entry;
  const url = attachmentEventUrl(payload as Record<string, unknown>, agentId);
  if (!url) return entry;
  return { ...entry, payload: { ...payload, url } };
}

type Emit = (entry: MetroEvent) => void;

export function makeEmit(dedupSeq?: DedupSeq): Emit {
  const tracker = dedupSeq ?? makeDedupSeq();
  return function emit(entry: MetroEvent): void {
    const seq = tracker.admit(entry);
    if (seq === null) return;
    const enriched: MetroEvent = withAttachmentUrl({
      ...entry,
      seq,
      agent: entry.agent ?? agentForLine(entry.line),
      display: entry.display ?? formatDisplay(entry),
      event: entry.event ?? classifyEvent(entry),
    });
    process.stdout.write(JSON.stringify(enriched) + '\n');
    publishEvent(enriched);
  };
}

function eventText(env: TrainEvent): string | undefined {
  if (env.text !== undefined) return env.text;
  return env.emoji ? `[react ${env.emoji}]` : undefined;
}

export function trainEventToMetroEvent(
  env: TrainEvent,
  trainName: string,
): MetroEvent | null {
  const line = env.line;
  if (typeof line !== 'string') {
    log.warn({ train: trainName }, 'train: dropped event without `line`');
    return null;
  }
  const station = env.station ?? Line.station(line) ?? trainName;
  const isPrivate = env.is_private === true;
  const text = eventText(env);
  return {
    event: env.event,
    agent: agentForLine(line),
    id: env.id ?? mintId(),
    ts: env.ts ?? new Date().toISOString(),
    station,
    line: line as MetroEvent['line'],
    lineName: env.line_name,
    from: (env.from ?? `metro://${station}`) as MetroEvent['from'],
    fromName: env.from_name,
    fromDisplayName: env.from_display_name,
    to: (env.to ?? (isPrivate ? userSelf() : line)) as MetroEvent['to'],
    text,
    messageId: env.message_id,
    replyTo: env.reply_to,
    payload: env.payload,
  };
}

type McpHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

export async function startWebhookServer(
  emit: Emit,
  mcp?: McpHandler,
  monitorCall?: MonitorCall,
  agentApi?: AgentApiDeps,
  connectorApi?: ConnectorApiDeps,
): Promise<Server> {
  const port = webhookPort();
  const server = createServer((req, res) => {
    handleRequest(
      req,
      res,
      emit,
      mcp,
      monitorCall,
      agentApi,
      connectorApi,
    ).catch((err: unknown) => {
      log.warn({ err: errMsg(err) }, 'webhook handler error');
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    const host = process.env.METRO_HTTP_HOST ?? '127.0.0.1';
    server.listen(port, host, () => {
      log.info(
        {
          host,
          port,
          endpoints: listEndpoints().length,
          mcp: mcp ? '/' : 'off',
        },
        'webhook + mcp ready',
      );
      resolve();
    });
  });
  return server;
}

function isMcpPath(req: IncomingMessage): boolean {
  const path = (req.url ?? '').split('?')[0];
  return path === '/' || path === '/mcp';
}

export const WEBHOOK_BODY_MAX = 25 * 1024 * 1024;

export class BodyTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`request body exceeds ${limit} bytes`);
  }
}

export async function readBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    const buf = c as Buffer;
    total += buf.length;
    if (total > maxBytes) throw new BodyTooLargeError(maxBytes);
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function flatHeaders(req: IncomingMessage): Record<string, string> {
  return Object.fromEntries(
    Object.entries(req.headers).map(([k, v]) => [
      k,
      Array.isArray(v) ? v.join(',') : (v ?? ''),
    ]),
  );
}

function parseBody(raw: Buffer): unknown {
  const text = raw.toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function handleWebhookPost(
  req: IncomingMessage,
  res: ServerResponse,
  emit: Emit,
  endpointId: string,
  endpoint: Endpoint,
): Promise<void> {
  let raw: Buffer;
  try {
    raw = await readBody(req, WEBHOOK_BODY_MAX);
  } catch (err) {
    if (!(err instanceof BodyTooLargeError)) throw err;
    log.warn({ endpoint: endpointId, limit: err.limit }, 'webhook body too large — rejecting');
    res.writeHead(413).end('payload too large');
    return;
  }
  const body = parseBody(raw);
  emit(
    webhookEntry(
      endpoint,
      flatHeaders(req),
      body,
      req.method ?? 'POST',
      hookPath(endpointId),
    ),
  );
  res.writeHead(200).end('ok');
}

function handleHealth(req: IncomingMessage, res: ServerResponse): boolean {
  const reqPath = (req.url ?? '').split('?')[0];
  if (reqPath !== '/health' && reqPath !== '/healthz') return false;
  res.writeHead(200, { 'content-type': 'application/json' }).end(
    JSON.stringify({
      status: 'ok',
      version: METRO_VERSION,
      uptime: Math.round(process.uptime()),
    }),
  );
  return true;
}

const HOOK_PATH =
  /^\/api\/webhooks\/([0-9]{17,20})\/([A-Za-z0-9_-]{32,128})$/;

const HOOK_PREFIX = '/api/webhooks/';

const hookPath = (webhookId: string): string => `${HOOK_PREFIX}${webhookId}`;

function hookTarget(
  path: string,
): { id: string; endpoint: Endpoint } | null {
  const m = HOOK_PATH.exec(path);
  const webhookId = m?.[1];
  const token = m?.[2];
  if (webhookId === undefined || token === undefined) return null;
  const endpoint = findEndpointByWebhookId(webhookId);
  if (!endpoint?.secret || !tokenMatches(endpoint.secret, token)) return null;
  return { id: webhookId, endpoint };
}

async function handleWebhookRoute(
  req: IncomingMessage,
  res: ServerResponse,
  emit: Emit,
): Promise<boolean> {
  const path = (req.url ?? '').split('?')[0] ?? '';
  if (!path.startsWith(HOOK_PREFIX)) return false;
  const target = hookTarget(path);
  if (target === null) {
    res.writeHead(404).end();
    return true;
  }
  if (req.method === 'GET') {
    res.writeHead(200).end(`metro webhook ${target.id} ready\n`);
    return true;
  }
  if (req.method !== 'POST') {
    res.writeHead(405).end();
    return true;
  }
  await handleWebhookPost(req, res, emit, target.id, target.endpoint);
  return true;
}

function handleSessionApis(
  req: IncomingMessage,
  res: ServerResponse,
  agentApi?: AgentApiDeps,
  connectorApi?: ConnectorApiDeps,
): boolean {
  if (agentApi && handleAgentApiRequest(req, res, agentApi)) return true;
  return Boolean(
    connectorApi && handleConnectorApiRequest(req, res, connectorApi),
  );
}

async function handlePreMcpRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  emit: Emit,
  monitorCall?: MonitorCall,
  agentApi?: AgentApiDeps,
  connectorApi?: ConnectorApiDeps,
): Promise<boolean> {
  if (handleHealth(req, res)) return true;
  if (await handleGoogleAuthRequest(req, res)) return true;
  if (handleSessionApis(req, res, agentApi, connectorApi)) return true;
  if (handleUploadRequest(req, res)) return true;
  if (handleAttachRequest(req, res)) return true;
  if (await handleWebhookRoute(req, res, emit)) return true;
  return Boolean(monitorCall && handleMonitorRequest(req, res, monitorCall));
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  emit: Emit,
  mcp?: McpHandler,
  monitorCall?: MonitorCall,
  agentApi?: AgentApiDeps,
  connectorApi?: ConnectorApiDeps,
): Promise<void> {
  if (
    await handlePreMcpRoutes(req, res, emit, monitorCall, agentApi, connectorApi)
  )
    return;
  if (mcp && isMcpPath(req)) {
    applyMcpCors(req, res);
    if (handleMcpPreflight(req, res)) return;
    await mcp(req, res);
    return;
  }
  res.writeHead(404).end();
}
