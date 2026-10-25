import type { IncomingMessage } from 'node:http';
import { isRecord } from '@metro-labs/core/is-record';
import { log } from '@metro-labs/core/log';
import { withoutCacheTtl, withoutTtlBeta } from './cache-ttl.js';
import { anthropicHeaders, GatewayError, type Watch } from './forward.js';

export const ROUTEWAY_BASE = 'https://api.routeway.ai';
const USER_AGENT = 'metro (+https://metro.box)';
const HANDED_OVER = new Set([402, 429]);

export function routewayHeaders(req: IncomingMessage, apiKey: string): Record<string, string> {
  const headers = anthropicHeaders(req, apiKey);
  headers['user-agent'] ??= USER_AGENT;
  const betas = withoutTtlBeta((headers['anthropic-beta'] ?? '').split(',').filter((beta) => beta !== ''));
  if (betas.length > 0) headers['anthropic-beta'] = betas.join(',');
  else delete headers['anthropic-beta'];
  return headers;
}

export async function refusedWithPage(upstream: Response, watch: Watch): Promise<void> {
  if (upstream.ok || HANDED_OVER.has(upstream.status) || !(upstream.headers.get('content-type') ?? '').includes('text/html')) return;
  await upstream.body?.cancel();
  watch.stop();
  throw new GatewayError(502, 'api_error', `metro gateway: Routeway answered with a web page instead of its API (${String(upstream.status)}); try again in a moment`);
}

const SCHEMA_MAPS = ['properties', 'patternProperties', '$defs', 'definitions'];
const SCHEMA_LISTS = ['anyOf', 'oneOf', 'allOf', 'prefixItems'];
const SCHEMA_ONES = ['items', 'additionalProperties', 'not', 'contains'];

function fitMap(raw: Record<string, unknown>): Record<string, unknown> {
  const entries = Object.entries(raw).map(([key, value]) => [key, fitSchema(value)] as const);
  return entries.some(([key, value]) => value !== raw[key]) ? Object.fromEntries(entries) : raw;
}

function fitList(raw: unknown[]): unknown[] {
  const fitted = raw.map(fitSchema);
  return fitted.some((value, at) => value !== raw[at]) ? fitted : raw;
}

function fitChild(key: string, value: unknown): unknown {
  if (SCHEMA_MAPS.includes(key)) return isRecord(value) ? fitMap(value) : value;
  if (SCHEMA_LISTS.includes(key)) return Array.isArray(value) ? fitList(value) : value;
  return SCHEMA_ONES.includes(key) ? fitSchema(value) : value;
}

function singleTypes(schema: Record<string, unknown>): Record<string, unknown> {
  const types: unknown = schema.type;
  if (!Array.isArray(types) || !types.every((type) => typeof type === 'string')) return schema;
  const rest = Object.fromEntries(Object.entries(schema).filter(([key]) => key !== 'type'));
  if (types.length === 1) return { ...rest, type: types[0] };
  const choices = types.map((type) => ({ type }));
  if (!Object.hasOwn(rest, 'anyOf')) return { ...rest, anyOf: choices };
  const { anyOf, ...others } = rest;
  return { ...others, allOf: [{ anyOf: choices }, { anyOf }] };
}

function fitSchema(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  const entries = Object.entries(raw).map(([key, value]) => [key, fitChild(key, value)] as const);
  const children = entries.some(([key, value]) => value !== raw[key]) ? Object.fromEntries(entries) : raw;
  return singleTypes(children);
}

function withProperties(tool: unknown): unknown {
  if (!isRecord(tool) || !isRecord(tool.input_schema)) return tool;
  const schema = fitSchema(tool.input_schema);
  const full = isRecord(schema) && !Object.hasOwn(schema, 'properties') ? { ...schema, properties: {} } : schema;
  return full === tool.input_schema ? tool : { ...tool, input_schema: full };
}

function routewayTools(body: Record<string, unknown>): Record<string, unknown> {
  const listed: unknown = body.tools;
  if (!Array.isArray(listed)) return body;
  const tools: unknown[] = listed.map(withProperties);
  return tools.some((tool, at) => tool !== listed[at]) ? { ...body, tools } : body;
}

export const routewayBody = (body: Record<string, unknown>): Record<string, unknown> => withoutCacheTtl(routewayTools(body));

export async function noteRoutewayRefusal(upstream: Response): Promise<void> {
  if (upstream.ok || !(upstream.headers.get('content-type') ?? '').includes('application/json')) return;
  const body: unknown = await upstream.clone().json().catch(() => null);
  const error = isRecord(body) && isRecord(body.error) ? body.error : null;
  if (error === null) return;
  const text = (value: unknown): string | null => (typeof value === 'string' ? value.slice(0, 300) : null);
  log.warn({ status: upstream.status, reason: text(error.message), param: text(error.param) }, 'gateway: Routeway refused the request');
}
