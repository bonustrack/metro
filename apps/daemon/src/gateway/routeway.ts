import type { IncomingMessage } from 'node:http';
import { anthropicHeaders, GatewayError, type Watch } from './forward.js';

export const ROUTEWAY_BASE = 'https://api.routeway.ai';
const USER_AGENT = 'metro (+https://metro.box)';
const HANDED_OVER = new Set([402, 429]);

export function routewayHeaders(req: IncomingMessage, apiKey: string): Record<string, string> {
  const headers = anthropicHeaders(req, apiKey);
  headers['user-agent'] ??= USER_AGENT;
  return headers;
}

export async function refusedWithPage(upstream: Response, watch: Watch): Promise<void> {
  if (upstream.ok || HANDED_OVER.has(upstream.status) || !(upstream.headers.get('content-type') ?? '').includes('text/html')) return;
  await upstream.body?.cancel();
  watch.stop();
  throw new GatewayError(502, 'api_error', `metro gateway: Routeway answered with a web page instead of its API (${String(upstream.status)}); try again in a moment`);
}
