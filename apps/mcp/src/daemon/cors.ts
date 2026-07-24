import type { IncomingMessage, ServerResponse } from 'node:http';

const ALLOWED_ORIGINS = new Set(['https://metro.box']);

const isDevOrigin = (origin: string): boolean =>
  /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);

const allowedOrigin = (req: IncomingMessage): string | undefined => {
  const origin = req.headers.origin;
  if (origin === undefined || origin === '') return undefined;
  if (ALLOWED_ORIGINS.has(origin) || isDevOrigin(origin)) return origin;
  return undefined;
};

export function applyMcpCors(
  req: IncomingMessage,
  res: ServerResponse,
): void {
  const origin = allowedOrigin(req);
  if (!origin) return;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Authorization, Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID',
  );
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
  res.setHeader('Access-Control-Max-Age', '86400');
}

export function handleMcpPreflight(
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  if (req.method !== 'OPTIONS') return false;
  res.writeHead(204).end();
  return true;
}
