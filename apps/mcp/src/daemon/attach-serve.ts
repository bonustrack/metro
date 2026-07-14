import { timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  guessMime,
  resolveCachedAttachment,
} from '../stations/attachments.js';
import { errMsg, log } from './log.js';
import { loadTunnelConfig } from './tunnel.js';

function attachToken(): string {
  return process.env.METRO_MCP_HTTP_TOKEN ?? '';
}

function tokenEq(given: string, want: string): boolean {
  const g = Buffer.from(given);
  const w = Buffer.from(want);
  return g.length === w.length && timingSafeEqual(g, w);
}

function authorized(req: IncomingMessage, q: URLSearchParams): boolean {
  const token = attachToken();
  if (!token) return true;
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ') && tokenEq(header.slice(7), token))
    return true;
  const qt = q.get('token');
  return Boolean(qt && tokenEq(qt, token));
}

export function publicBaseUrl(): string | null {
  const env = process.env.METRO_PUBLIC_URL?.trim();
  if (env) return env.replace(/\/+$/, '');
  const host = loadTunnelConfig()?.hostname;
  return host ? `https://${host}` : null;
}

export function attachmentUrl(pathOrName: string): string | null {
  const base = publicBaseUrl();
  if (!base) return null;
  const name = pathOrName.split('/').pop();
  if (!name || !resolveCachedAttachment(name)) return null;
  const token = attachToken();
  const suffix = token ? `?token=${encodeURIComponent(token)}` : '';
  return `${base}/attach/${encodeURIComponent(name)}${suffix}`;
}

export function attachmentEventUrl(
  payload: Record<string, unknown>,
): string | null {
  if (payload.contentType !== 'attachmentSaved') return null;
  if (typeof payload.url === 'string' && payload.url.length > 0) return null;
  const p = payload.attachmentPath ?? payload.localPath;
  return typeof p === 'string' ? attachmentUrl(p) : null;
}

async function serveFile(
  res: ServerResponse,
  method: string,
  name: string,
): Promise<void> {
  const path = resolveCachedAttachment(name);
  if (!path) {
    res.writeHead(404).end();
    return;
  }
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, {
    'content-type': guessMime(path),
    'content-length': String(size),
    'cache-control': 'private, max-age=86400',
  });
  if (method === 'HEAD') {
    res.end();
    return;
  }
  const stream = createReadStream(path);
  stream.on('error', (err) => {
    log.warn({ err: errMsg(err) }, 'attach: read stream error');
    res.end();
  });
  stream.pipe(res);
}

export function handleAttachRequest(
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  const [rawPath, qs = ''] = (req.url ?? '').split('?', 2);
  const m = /^\/attach\/([^/]+)$/.exec(rawPath ?? '');
  if (!m) return false;
  const method = req.method ?? 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    res.writeHead(405).end();
    return true;
  }
  if (!authorized(req, new URLSearchParams(qs))) {
    res.writeHead(401).end();
    return true;
  }
  const name = decodeURIComponent(m[1] ?? '');
  void serveFile(res, method, name).catch((err: unknown) => {
    log.warn({ err: errMsg(err) }, 'attach: serve error');
    if (!res.headersSent) res.writeHead(500).end();
  });
  return true;
}
