import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { Line } from '../lines.js';
import { errMsg, log } from '../log.js';
import { noteSeen } from '../paths.js';
import {
  appendHistory,
  classifyEvent,
  formatDisplay,
  mintId,
  noteUserFromLine,
  userSelf,
  type HistoryEntry,
} from '../history.js';
import { handleMonitorRequest } from '../monitor-api.js';
import type { TrainEvent } from '../trains/protocol.js';
import { findEndpoint, listEndpoints, webhookPort } from '../tunnel.js';
import { webhookEntry, verifyWebhookSig } from '../stations/webhook/receive.js';
import { makeDedupSeq, type DedupSeq } from './dedup-seq.js';
import { HISTORY_FILE } from '../paths.js';

type Emit = (entry: HistoryEntry) => void;

export function makeEmit(dedupSeq?: DedupSeq): Emit {
  const tracker = dedupSeq ?? makeDedupSeq(HISTORY_FILE);
  return function emit(entry: HistoryEntry): void {
    const seq = tracker.admit(entry);
    if (seq === null) return;
    const enriched: HistoryEntry = {
      ...entry,
      seq,
      display: entry.display ?? formatDisplay(entry),
      event: entry.event ?? classifyEvent(entry),
    };
    process.stdout.write(JSON.stringify(enriched) + '\n');
    noteSeen(entry.line, entry.lineName);
    for (const l of [entry.line, entry.from, entry.to])
      if (l) noteUserFromLine(l);
    appendHistory(enriched);
  };
}

export function trainEventToHistoryEntry(
  env: TrainEvent,
  trainName: string,
): HistoryEntry | null {
  const line = env.line;
  if (typeof line !== 'string') {
    log.warn({ train: trainName }, 'train: dropped event without `line`');
    return null;
  }
  const station = env.station ?? Line.station(line) ?? trainName;
  const isPrivate = env.is_private === true;
  const text = env.text ?? (env.emoji ? `[react ${env.emoji}]` : undefined);
  return {
    event: env.event,
    id: env.id ?? mintId(),
    ts: env.ts ?? new Date().toISOString(),
    station,
    line: line as HistoryEntry['line'],
    lineName: env.line_name,
    from: (env.from ?? `metro://${station}`) as HistoryEntry['from'],
    fromName: env.from_name,
    to: (env.to ?? (isPrivate ? userSelf() : line)) as HistoryEntry['to'],
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
): Promise<Server> {
  const port = webhookPort();
  const server = createServer((req, res) => {
    handleRequest(req, res, emit, mcp).catch((err: unknown) => {
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
        'webhook + monitor + mcp ready',
      );
      resolve();
    });
  });
  return server;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  emit: Emit,
  mcp?: McpHandler,
): Promise<void> {
  if (handleMonitorRequest(req, res)) return;
  if (mcp) {
    const path = (req.url ?? '').split('?')[0];
    if (path === '/' || path === '/mcp') {
      await mcp(req, res);
      return;
    }
  }
  const m = req.url?.match(/^\/wh\/([A-Za-z0-9_-]+)/);
  if (!m) {
    res.writeHead(404).end();
    return;
  }
  const endpointId = m[1];
  const endpoint = findEndpoint(endpointId);
  if (!endpoint) {
    res.writeHead(404).end();
    return;
  }
  if (req.method === 'GET') {
    res.writeHead(200).end(`metro webhook ${endpointId} ready\n`);
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405).end();
    return;
  }

  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks);
  const headers = Object.fromEntries(
    Object.entries(req.headers).map(([k, v]) => [
      k,
      Array.isArray(v) ? v.join(',') : (v ?? ''),
    ]),
  );
  if (
    endpoint.secret &&
    !verifyWebhookSig(endpoint.secret, raw, headers['x-hub-signature-256'])
  ) {
    log.warn(
      { endpoint: endpointId },
      'webhook signature mismatch — rejecting',
    );
    res.writeHead(401).end('signature mismatch');
    return;
  }
  let body: unknown = raw.toString('utf8');
  try {
    body = JSON.parse(body as string);
  } catch {
  }

  emit(
    webhookEntry(endpoint, headers, body, req.method ?? 'POST', req.url ?? ''),
  );
  res.writeHead(200).end('ok');
}
