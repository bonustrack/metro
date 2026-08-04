import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  guessMime,
  resolveCachedAttachment,
} from '../stations/attachments.js';
import { keyForAgent } from '../db/key-map.js';
import {
  allowedAgents,
  authConfigFromEnv,
  authenticate,
} from '../mcp/request-identity.js';
import { attachmentOwner, recordAttachmentOwner } from './attach-owner.js';
import { errMsg, log } from './log.js';
import { loadTunnelConfig } from './tunnel.js';

function authorized(req: IncomingMessage, name: string): boolean {
  const owner = attachmentOwner(name);
  if (owner === undefined) return false;
  return allowedAgents(authenticate(req, authConfigFromEnv()) ?? undefined).has(
    owner,
  );
}

export function publicBaseUrl(): string | null {
  const env = process.env.METRO_PUBLIC_URL?.trim();
  if (env) return env.replace(/\/+$/, '');
  const host = loadTunnelConfig()?.hostname;
  return host ? `https://${host}` : null;
}

export function attachmentUrl(
  pathOrName: string,
  agentId: number,
): string | null {
  const base = publicBaseUrl();
  if (!base) return null;
  const name = pathOrName.split('/').pop();
  if (!name || !resolveCachedAttachment(name)) return null;
  const key = keyForAgent(agentId);
  if (key === undefined) return null;
  recordAttachmentOwner(name, agentId);
  return `${base}/attach/${encodeURIComponent(name)}?token=${encodeURIComponent(key)}`;
}

export function attachmentEventUrl(
  payload: Record<string, unknown>,
  agentId: number,
): string | null {
  if (payload.contentType !== 'attachmentSaved') return null;
  if (typeof payload.url === 'string' && payload.url.length > 0) return null;
  const p = payload.attachmentPath ?? payload.localPath;
  return typeof p === 'string' ? attachmentUrl(p, agentId) : null;
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
  const [rawPath] = (req.url ?? '').split('?', 2);
  const m = /^\/attach\/([^/]+)$/.exec(rawPath ?? '');
  if (!m) return false;
  const method = req.method ?? 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    res.writeHead(405).end();
    return true;
  }
  const name = decodeURIComponent(m[1] ?? '');
  if (!authorized(req, name)) {
    res.writeHead(401).end();
    return true;
  }
  void serveFile(res, method, name).catch((err: unknown) => {
    log.warn({ err: errMsg(err) }, 'attach: serve error');
    if (!res.headersSent) res.writeHead(500).end();
  });
  return true;
}
