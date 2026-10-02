import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

export const STANDIN_KEY = 'sk-ant-api03-metro-harness-standin-key';
const ANTHROPIC = 'https://api.anthropic.com';
const OAUTH_BETA = 'oauth-2025-04-20';
const DROPPED = new Set(['host', 'x-api-key', 'content-length', 'connection', 'authorization', 'accept-encoding']);

export interface StandInStats {
  requests: number;
  withKey: number;
  withAuthorization: number;
  withOauthBeta: number;
  withMetroKey: number;
  models: Record<string, number>;
  statuses: Record<string, number>;
}

export interface StandIn {
  stats: StandInStats;
  close(): void;
}

function loginToken(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
  const parsed = JSON.parse(readFileSync(join(dir, '.credentials.json'), 'utf8')) as { claudeAiOauth?: { accessToken?: string } };
  const token = parsed.claudeAiOauth?.accessToken ?? '';
  if (token === '') throw new Error('no Claude login on this box to stand in for Anthropic');
  return token;
}

const header = (req: IncomingMessage, name: string): string => {
  const value = req.headers[name];
  return Array.isArray(value) ? value.join(',') : (value ?? '');
};

function note(stats: StandInStats, req: IncomingMessage, body: Buffer): void {
  stats.requests += 1;
  if (header(req, 'x-api-key') === STANDIN_KEY) stats.withKey += 1;
  if (header(req, 'authorization') !== '') stats.withAuthorization += 1;
  if (header(req, 'anthropic-beta').includes('oauth')) stats.withOauthBeta += 1;
  if (header(req, 'x-metro-key') !== '') stats.withMetroKey += 1;
  try {
    const model = (JSON.parse(body.toString('utf8')) as { model?: string }).model ?? '?';
    stats.models[model] = (stats.models[model] ?? 0) + 1;
  } catch {
    stats.models['?'] = (stats.models['?'] ?? 0) + 1;
  }
}

function upstreamHeaders(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) if (!DROPPED.has(name) && value !== undefined) out[name] = Array.isArray(value) ? value.join(',') : value;
  const betas = (out['anthropic-beta'] ?? '').split(',').map((b) => b.trim()).filter((b) => b !== '');
  out['anthropic-beta'] = [...betas, OAUTH_BETA].join(',');
  out.authorization = `Bearer ${loginToken()}`;
  return out;
}

async function relay(req: IncomingMessage, res: ServerResponse, stats: StandInStats): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks);
  note(stats, req, body);
  const upstream = await fetch(`${ANTHROPIC}${req.url ?? ''}`, { method: req.method ?? 'POST', headers: upstreamHeaders(req), body: req.method === 'GET' ? undefined : new Uint8Array(body) });
  stats.statuses[String(upstream.status)] = (stats.statuses[String(upstream.status)] ?? 0) + 1;
  const headers: Record<string, string> = {};
  upstream.headers.forEach((value, name) => {
    if (name !== 'content-encoding' && name !== 'content-length' && name !== 'transfer-encoding') headers[name] = value;
  });
  res.writeHead(upstream.status, headers);
  if (upstream.body === null) {
    res.end();
    return;
  }
  Readable.fromWeb(upstream.body as never).pipe(res);
}

export async function startStandIn(port: number): Promise<StandIn> {
  const stats: StandInStats = { requests: 0, withKey: 0, withAuthorization: 0, withOauthBeta: 0, withMetroKey: 0, models: {}, statuses: {} };
  const server = createServer((req, res) => {
    relay(req, res, stats).catch((err: unknown) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: err instanceof Error ? err.message : String(err) } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', () => resolve()));
  return {
    stats,
    close: () => {
      server.close();
    },
  };
}
