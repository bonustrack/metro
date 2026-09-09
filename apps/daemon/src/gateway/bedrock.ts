import type { IncomingMessage, ServerResponse } from 'node:http';
import { log } from '@metro-labs/core/log';
import { EventStreamDecoder, type EventStreamMessage } from './eventstream.js';
import { errorFrame, GatewayError, idleMessage, providerStatus, sendError, upstreamMessage, type Watch } from './forward.js';
import type { BedrockSettings } from './model-config.js';

const ANTHROPIC_VERSION = 'bedrock-2023-05-31';
const EXTRA_INPUT_RE = /^([A-Za-z0-9_]+)(?:\.[^:]*)?: Extra inputs are not permitted/;
const MAX_REPAIRS = 4;
const PING_MS = 25_000;

export interface Adaptations {
  fields: Set<string>;
  dropBetas: boolean;
}

export const freshAdaptations = (): Adaptations => ({ fields: new Set(), dropBetas: false });

export interface BedrockUpstream {
  settings: BedrockSettings;
  base: string;
  learned: Adaptations;
  watch: Watch;
}

interface Rewritten {
  modelId: string;
  stream: boolean;
  body: Record<string, unknown>;
  betas: string[];
}

interface Attempt {
  body: Record<string, unknown>;
  betas: string[];
}

const PREFIXES: [RegExp, string][] = [
  [/^us-gov-/, 'us-gov'],
  [/^us-/, 'us'],
  [/^eu-/, 'eu'],
  [/^ap-/, 'apac'],
];

export function regionPrefix(region: string): string {
  for (const [pattern, prefix] of PREFIXES) if (pattern.test(region)) return prefix;
  return 'global';
}

export function bedrockModelId(requested: string, region: string): string {
  if (requested.includes('anthropic.')) return requested;
  return `${regionPrefix(region)}.anthropic.${requested}`;
}

export const bedrockBase = (region: string): string => `https://bedrock-runtime.${region}.amazonaws.com`;

function splitBetas(header: string | string[] | undefined): string[] {
  const raw = Array.isArray(header) ? header.join(',') : (header ?? '');
  return raw
    .split(',')
    .map((b) => b.trim())
    .filter((b) => b !== '');
}

export function rewriteForBedrock(
  body: Record<string, unknown>,
  model: string,
  betaHeader: string | string[] | undefined,
  region: string,
): Rewritten {
  const betas = splitBetas(betaHeader);
  const out: Record<string, unknown> = {
    ...Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'model' && key !== 'stream')),
    anthropic_version: ANTHROPIC_VERSION,
  };
  if (betas.length > 0) out.anthropic_beta = betas;
  return { modelId: bedrockModelId(model, region), stream: body.stream === true, body: out, betas };
}

export function errorKind(status: number, errorType: string | null): string {
  if (status === 429 || errorType === 'ThrottlingException') return 'rate_limit_error';
  if (status === 400) return 'invalid_request_error';
  if (status === 401 || status === 403) return 'permission_error';
  if (status === 404) return 'not_found_error';
  if (status === 503) return 'overloaded_error';
  return 'api_error';
}

const invokeUrl = (up: BedrockUpstream, modelId: string, action: string): string =>
  `${up.base}/model/${encodeURIComponent(modelId)}/${action}`;

function callBedrock(up: BedrockUpstream, url: string, body: unknown, accept: string): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${up.settings.apiKey}`,
      'content-type': 'application/json',
      accept,
    },
    body: JSON.stringify(body),
    signal: up.watch.signal,
  });
}

const without = (body: Record<string, unknown>, keys: Set<string>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(body).filter(([key]) => !keys.has(key)));

function applyLearned(req: Rewritten, learned: Adaptations): Attempt {
  const dropped = new Set(learned.fields);
  if (learned.dropBetas) dropped.add('anthropic_beta');
  return { body: without(req.body, dropped), betas: learned.dropBetas ? [] : req.betas };
}

function repair(attempt: Attempt, learned: Adaptations, message: string): Attempt | null {
  const named = EXTRA_INPUT_RE.exec(message)?.[1];
  if (named !== undefined && named in attempt.body) {
    learned.fields.add(named);
    log.warn({ field: named }, 'gateway: Bedrock refused an extra input; dropping it from every request');
    return { body: without(attempt.body, new Set([named])), betas: attempt.betas };
  }
  if (attempt.betas.length > 0) {
    learned.dropBetas = true;
    log.warn({ betas: attempt.betas }, 'gateway: retrying without anthropic_beta');
    return { body: without(attempt.body, new Set(['anthropic_beta'])), betas: [] };
  }
  return null;
}

async function withRepairs(up: BedrockUpstream, req: Rewritten, send: (attempt: Attempt) => Promise<Response>): Promise<Response> {
  let attempt = applyLearned(req, up.learned);
  for (let repairs = 0; ; repairs += 1) {
    const res = await send(attempt);
    if (res.status !== 400 || repairs >= MAX_REPAIRS) return res;
    const text = await res.text();
    const next = repair(attempt, up.learned, upstreamMessage(text, 'Bedrock returned no body'));
    if (next === null) return new Response(text, { status: 400, headers: res.headers });
    attempt = next;
  }
}

function invoke(up: BedrockUpstream, req: Rewritten): Promise<Response> {
  const action = req.stream ? 'invoke-with-response-stream' : 'invoke';
  const accept = req.stream ? 'application/vnd.amazon.eventstream' : 'application/json';
  const url = invokeUrl(up, req.modelId, action);
  return withRepairs(up, req, (attempt) => callBedrock(up, url, attempt.body, accept));
}

function eventTypeOf(event: string): string {
  try {
    const parsed = JSON.parse(event) as { type?: unknown };
    return typeof parsed.type === 'string' ? parsed.type : 'message';
  } catch {
    return 'message';
  }
}

function writeEvent(res: ServerResponse, message: EventStreamMessage): void {
  if (message.headers[':message-type'] === 'event') {
    const parsed = JSON.parse(message.payload.toString('utf8')) as { bytes?: unknown };
    if (typeof parsed.bytes !== 'string') return;
    const event = Buffer.from(parsed.bytes, 'base64').toString('utf8');
    res.write(`event: ${eventTypeOf(event)}\ndata: ${event}\n\n`);
    return;
  }
  const errorType = message.headers[':exception-type'] ?? message.headers[':error-code'] ?? null;
  const body = {
    type: 'error',
    error: { type: errorKind(500, errorType), message: upstreamMessage(message.payload.toString('utf8'), 'Bedrock stream error') },
  };
  res.write(`event: error\ndata: ${JSON.stringify(body)}\n\n`);
}

async function relayStream(upstream: Response, res: ServerResponse, watch: Watch): Promise<void> {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
  const body = upstream.body;
  if (body === null) {
    res.end();
    return;
  }
  const ping = setInterval(() => res.write('event: ping\ndata: {"type":"ping"}\n\n'), PING_MS);
  try {
    const decoder = new EventStreamDecoder();
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      watch.touch();
      for (const message of decoder.push(Buffer.from(value))) writeEvent(res, message);
    }
  } catch (err) {
    if (!watch.idle()) throw err;
    res.write(errorFrame('api_error', idleMessage(watch.ms)));
  } finally {
    clearInterval(ping);
    watch.stop();
    res.end();
  }
}

async function relayFailure(upstream: Response, res: ServerResponse): Promise<void> {
  const text = await upstream.text();
  sendError(res, providerStatus(upstream.status), errorKind(upstream.status, upstream.headers.get('x-amzn-errortype')), upstreamMessage(text, 'Bedrock returned no body'));
}

export async function bedrockMessages(
  req: IncomingMessage,
  res: ServerResponse,
  body: Record<string, unknown>,
  model: string,
  up: BedrockUpstream,
): Promise<void> {
  const rewritten = rewriteForBedrock(body, model, req.headers['anthropic-beta'], up.settings.region);
  const upstream = await invoke(up, rewritten);
  if (!upstream.ok) {
    await relayFailure(upstream, res);
    return;
  }
  if (rewritten.stream) {
    await relayStream(upstream, res, up.watch);
    return;
  }
  const text = await upstream.text();
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(text);
}

const estimateTokens = (body: Record<string, unknown>): number => Math.ceil(JSON.stringify(body).length / 4);

export async function bedrockCount(
  req: IncomingMessage,
  res: ServerResponse,
  body: Record<string, unknown>,
  model: string,
  up: BedrockUpstream,
): Promise<void> {
  const rewritten = rewriteForBedrock(body, model, req.headers['anthropic-beta'], up.settings.region);
  const url = invokeUrl(up, rewritten.modelId, 'count-tokens');
  const upstream = await withRepairs(up, rewritten, (attempt) => callBedrock(up, url, { input: { invokeModel: { body: JSON.stringify(attempt.body) } } }, 'application/json'));
  const text = await upstream.text();
  let counted: number | null = null;
  if (upstream.ok) {
    const parsed = JSON.parse(text) as { inputTokens?: unknown };
    if (typeof parsed.inputTokens === 'number') counted = parsed.inputTokens;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ input_tokens: counted ?? estimateTokens(rewritten.body) }));
}

export function assertBedrockReady(settings: BedrockSettings): void {
  if (settings.apiKey === '' || settings.region === '')
    throw new GatewayError(400, 'invalid_request_error', 'Bedrock needs an API key and a region: add them on the Model page.');
}
