import type { IncomingMessage, ServerResponse } from 'node:http';

export function applyMcpCors(
  req: IncomingMessage,
  res: ServerResponse,
): void {
  const origin = req.headers.origin;
  res.setHeader(
    'Access-Control-Allow-Origin',
    origin !== undefined && origin !== '' ? origin : '*',
  );
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
