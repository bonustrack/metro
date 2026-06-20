/** Dispatcher's plumbing: outbound event emission + train-envelope translation + HTTP receiver. */

import {
  createServer, type IncomingMessage, type Server, type ServerResponse,
} from 'node:http';
import { Line } from '../lines.js';
import { errMsg, log } from '../log.js';
import { noteSeen } from '../paths.js';
import {
  appendHistory, classifyEvent, formatDisplay, mintId, noteUserFromLine, userSelf,
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
  /** Inbound dedup + per-line seq. Seeded from the history tail (warm-start) so a */
  /** daemon restart doesn't re-admit train replays. Injectable for tests. */
  const tracker = dedupSeq ?? makeDedupSeq(HISTORY_FILE);
  return function emit(entry: HistoryEntry): void {
    /** Dedup inbound train replays + assign this line's next seq. A duplicate (same */
    /** platform messageId within the LRU window) returns null ⇒ drop before any I/O. */
    const seq = tracker.admit(entry);
    if (seq === null) return;
    /** Spread first, then `display`, so the computed bubble wins (old order let a stale one clobber it). */
    const enriched: HistoryEntry = {
      ...entry,
      seq,
      display: entry.display ?? formatDisplay(entry),
      event: entry.event ?? classifyEvent(entry),
    };
    process.stdout.write(JSON.stringify(enriched) + '\n');
    noteSeen(entry.line, entry.lineName);
    for (const l of [entry.line, entry.from, entry.to]) if (l) noteUserFromLine(l);
    appendHistory(enriched);
  };
}

/** Translate the snake_case train wire envelope to a camelCase `HistoryEntry`. */
/** Trains can omit `id`/`station`/`to`; metro fills sensible defaults. */
export function trainEventToHistoryEntry(env: TrainEvent, trainName: string): HistoryEntry | null {
  const line = env.line;
  if (typeof line !== 'string') {
    log.warn({ train: trainName }, 'train: dropped event without `line`');
    return null;
  }
  const station = env.station ?? Line.station(line) ?? trainName;
  const isPrivate = env.is_private === true;
  /** Trains may still emit `emoji` for reactions — fold it into text so the new envelope stays minimal. */
  const text = env.text ?? (env.emoji ? `[react ${env.emoji}]` : undefined);
  return {
    /** Carry the typed content-type verbatim when the train sets it (canonical path); */
    /** the emit wrapper falls back to `classifyEvent` only when absent (legacy parity). */
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

/** Handler for the in-process MCP surface mounted at /mcp (see src/mcp/index.ts). */
type McpHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

export async function startWebhookServer(emit: Emit, mcp?: McpHandler): Promise<Server> {
  const port = webhookPort();
  const server = createServer((req, res) => {
    handleRequest(req, res, emit, mcp).catch(err => {
      log.warn({ err: errMsg(err) }, 'webhook handler error');
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    /** Bind 127.0.0.1 by default (local safety); set METRO_HTTP_HOST=0.0.0.0 when a
     *  platform proxy (Fly, etc.) must reach the app on the machine's network. */
    const host = process.env.METRO_HTTP_HOST ?? '127.0.0.1';
    server.listen(port, host, () => {
      log.info({ host, port, endpoints: listEndpoints().length, mcp: mcp ? '/' : 'off' }, 'webhook + monitor + mcp ready');
      resolve();
    });
  });
  return server;
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, emit: Emit, mcp?: McpHandler): Promise<void> {
  if (handleMonitorRequest(req, res)) return;
  /** The MCP surface lives at the ROOT path (POST = JSON-RPC, GET = server→client
   *  SSE) so it can sit behind its own host, e.g. https://mcp.metro.box. `/mcp`
   *  stays as an alias. /health + /api/* (above) and /wh/* (below) match around it. */
  if (mcp) {
    const path = (req.url ?? '').split('?')[0];
    if (path === '/' || path === '/mcp') { await mcp(req, res); return; }
  }
  const m = req.url?.match(/^\/wh\/([A-Za-z0-9_-]+)/);
  if (!m) { res.writeHead(404).end(); return; }
  const endpointId = m[1];
  const endpoint = findEndpoint(endpointId);
  if (!endpoint) { res.writeHead(404).end(); return; }
  if (req.method === 'GET') { res.writeHead(200).end(`metro webhook ${endpointId} ready\n`); return; }
  if (req.method !== 'POST') { res.writeHead(405).end(); return; }

  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks);
  const headers = Object.fromEntries(
    Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : v ?? '']),
  );
  if (endpoint.secret && !verifyWebhookSig(endpoint.secret, raw, headers['x-hub-signature-256'])) {
    log.warn({ endpoint: endpointId }, 'webhook signature mismatch — rejecting');
    res.writeHead(401).end('signature mismatch');
    return;
  }
  let body: unknown = raw.toString('utf8');
  try { body = JSON.parse(body as string); } catch { /* keep as string */ }

  emit(webhookEntry(endpoint, headers, body, req.method ?? 'POST', req.url ?? ''));
  res.writeHead(200).end('ok');
}
