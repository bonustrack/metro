import type { IncomingMessage } from 'node:http';
import { isRecord } from '@metro-labs/core/is-record';
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

function withProperties(tool: unknown): unknown {
  if (!isRecord(tool) || !isRecord(tool.input_schema) || Object.hasOwn(tool.input_schema, 'properties')) return tool;
  return { ...tool, input_schema: { ...tool.input_schema, properties: {} } };
}

export function routewayTools(body: Record<string, unknown>): Record<string, unknown> {
  const listed: unknown = body.tools;
  if (!Array.isArray(listed)) return body;
  const tools: unknown[] = listed.map(withProperties);
  return tools.some((tool, at) => tool !== listed[at]) ? { ...body, tools } : body;
}
