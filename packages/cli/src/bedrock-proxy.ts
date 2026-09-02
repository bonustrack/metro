import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { EventStreamDecoder, type EventStreamMessage } from './bedrock-eventstream.js';

export interface BedrockConfig {
  region: string;
  bearerToken: string;
  model: string | null;
}

export class BedrockConfigError extends Error {}

export class ProxyError extends Error {
  constructor(
    readonly status: number,
    readonly kind: string,
    message: string,
  ) {
    super(message);
  }
}

const ANTHROPIC_VERSION = 'bedrock-2023-05-31';
const BODY_MAX = 64 * 1024 * 1024;
const MESSAGES_PATH = '/v1/messages';
const COUNT_PATH = '/v1/messages/count_tokens';

function firstEnv(env: NodeJS.ProcessEnv, names: string[]): string {
  for (const name of names) {
    const value = env[name]?.trim() ?? '';
    if (value !== '') return value;
  }
  return '';
}

export function bedrockConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): BedrockConfig {
  const bearerToken = firstEnv(env, ['AWS_BEARER_TOKEN_BEDROCK']);
  if (bearerToken === '')
    throw new BedrockConfigError(
      'AWS_BEARER_TOKEN_BEDROCK is not set. Create an Amazon Bedrock API key in the AWS console (Bedrock → API keys) and export it.',
    );
  const region = firstEnv(env, ['METRO_BEDROCK_REGION', 'AWS_REGION', 'AWS_DEFAULT_REGION']);
  if (region === '')
    throw new BedrockConfigError(
      'no AWS region: set AWS_REGION (or METRO_BEDROCK_REGION) to the region your Bedrock API key belongs to',
    );
  const model = firstEnv(env, ['METRO_BEDROCK_MODEL']);
  return { region, bearerToken, model: model === '' ? null : model };
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

export function mapModel(requested: string, cfg: BedrockConfig): string {
  if (cfg.model !== null) return cfg.model;
  if (requested.includes('anthropic.')) return requested;
  return `${regionPrefix(cfg.region)}.anthropic.${requested}`;
}

export const upstreamBase = (cfg: BedrockConfig, override?: string): string =>
  override ?? `https://bedrock-runtime.${cfg.region}.amazonaws.com`;

export interface Rewritten {
  modelId: string;
  stream: boolean;
  body: Record<string, unknown>;
  betas: string[];
}

function splitBetas(header: string | string[] | undefined): string[] {
  const raw = Array.isArray(header) ? header.join(',') : (header ?? '');
  return raw
    .split(',')
    .map((b) => b.trim())
    .filter((b) => b !== '');
}

export function rewriteBody(
  raw: unknown,
  betaHeader: string | string[] | undefined,
  cfg: BedrockConfig,
): Rewritten {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    throw new ProxyError(400, 'invalid_request_error', 'body must be a JSON object');
  const { model, stream, ...rest } = raw as Record<string, unknown>;
  if (typeof model !== 'string' || model === '')
    throw new ProxyError(400, 'invalid_request_error', 'model is required');
  const betas = splitBetas(betaHeader);
  const body: Record<string, unknown> = { ...rest, anthropic_version: ANTHROPIC_VERSION };
  if (betas.length > 0) body.anthropic_beta = betas;
  return { modelId: mapModel(model, cfg), stream: stream === true, body, betas };
}

export function errorKind(status: number, errorType: string | null): string {
  if (status === 429 || errorType === 'ThrottlingException') return 'rate_limit_error';
  if (status === 400) return 'invalid_request_error';
  if (status === 401) return 'authentication_error';
  if (status === 403) return 'permission_error';
  if (status === 404) return 'not_found_error';
  if (status === 503) return 'overloaded_error';
  return 'api_error';
}

function sendError(
  res: ServerResponse,
  status: number,
  kind: string,
  message: string,
): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: { type: kind, message } }));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > BODY_MAX) throw new ProxyError(413, 'invalid_request_error', 'request too large');
    chunks.push(buf);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ProxyError(400, 'invalid_request_error', 'body must be JSON');
  }
}

interface Upstream {
  cfg: BedrockConfig;
  base: string;
}

function invokeUrl(up: Upstream, modelId: string, action: string): string {
  return `${up.base}/model/${encodeURIComponent(modelId)}/${action}`;
}

function callBedrock(
  up: Upstream,
  url: string,
  body: unknown,
  accept: string,
  signal: AbortSignal,
): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${up.cfg.bearerToken}`,
      'content-type': 'application/json',
      accept,
    },
    body: JSON.stringify(body),
    signal,
  });
}

async function invoke(
  up: Upstream,
  req: Rewritten,
  signal: AbortSignal,
): Promise<Response> {
  const action = req.stream ? 'invoke-with-response-stream' : 'invoke';
  const accept = req.stream ? 'application/vnd.amazon.eventstream' : 'application/json';
  const url = invokeUrl(up, req.modelId, action);
  const first = await callBedrock(up, url, req.body, accept, signal);
  if (first.status !== 400 || req.betas.length === 0) return first;
  await first.text();
  process.stderr.write(
    `metro bedrock: retrying without anthropic_beta [${req.betas.join(', ')}]\n`,
  );
  const stripped = Object.fromEntries(
    Object.entries(req.body).filter(([key]) => key !== 'anthropic_beta'),
  );
  return callBedrock(up, url, stripped, accept, signal);
}

function upstreamMessage(text: string): string {
  try {
    const parsed = JSON.parse(text) as { message?: unknown; Message?: unknown };
    const message = parsed.message ?? parsed.Message;
    if (typeof message === 'string' && message !== '') return message;
  } catch {
    return text === '' ? 'Bedrock returned no body' : text;
  }
  return text === '' ? 'Bedrock returned no body' : text;
}

async function relayError(upstream: Response, res: ServerResponse): Promise<void> {
  const text = await upstream.text();
  const kind = errorKind(upstream.status, upstream.headers.get('x-amzn-errortype'));
  sendError(res, upstream.status, kind, upstreamMessage(text));
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
  const errorType =
    message.headers[':exception-type'] ?? message.headers[':error-code'] ?? null;
  const body = {
    type: 'error',
    error: {
      type: errorKind(500, errorType),
      message: upstreamMessage(message.payload.toString('utf8')),
    },
  };
  res.write(`event: error\ndata: ${JSON.stringify(body)}\n\n`);
}

async function relayStream(upstream: Response, res: ServerResponse): Promise<void> {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  });
  const body = upstream.body;
  if (body === null) {
    res.end();
    return;
  }
  const decoder = new EventStreamDecoder();
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const message of decoder.push(Buffer.from(value))) writeEvent(res, message);
  }
  res.end();
}

async function relayJson(upstream: Response, res: ServerResponse): Promise<void> {
  const text = await upstream.text();
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(text);
}

async function handleMessages(
  req: IncomingMessage,
  res: ServerResponse,
  up: Upstream,
): Promise<void> {
  const rewritten = rewriteBody(await readBody(req), req.headers['anthropic-beta'], up.cfg);
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });
  const upstream = await invoke(up, rewritten, controller.signal);
  if (!upstream.ok) {
    await relayError(upstream, res);
    return;
  }
  if (rewritten.stream) await relayStream(upstream, res);
  else await relayJson(upstream, res);
}

function estimateTokens(body: Record<string, unknown>): number {
  return Math.ceil(JSON.stringify(body).length / 4);
}

async function handleCount(
  req: IncomingMessage,
  res: ServerResponse,
  up: Upstream,
): Promise<void> {
  const rewritten = rewriteBody(await readBody(req), req.headers['anthropic-beta'], up.cfg);
  const controller = new AbortController();
  const upstream = await callBedrock(
    up,
    invokeUrl(up, rewritten.modelId, 'count-tokens'),
    { input: { invokeModel: { body: JSON.stringify(rewritten.body) } } },
    'application/json',
    controller.signal,
  );
  const text = await upstream.text();
  let counted: number | null = null;
  if (upstream.ok) {
    const parsed = JSON.parse(text) as { inputTokens?: unknown };
    if (typeof parsed.inputTokens === 'number') counted = parsed.inputTokens;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ input_tokens: counted ?? estimateTokens(rewritten.body) }));
}

function presentedToken(req: IncomingMessage): string {
  const auth = req.headers.authorization ?? '';
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  const key = req.headers['x-api-key'];
  return Array.isArray(key) ? (key[0] ?? '') : (key ?? '');
}

export interface ProxyOptions {
  token: string;
  upstream?: string;
  port?: number;
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: BedrockConfig,
  opts: ProxyOptions,
): Promise<void> {
  if (presentedToken(req) !== opts.token)
    throw new ProxyError(401, 'authentication_error', 'unauthorized');
  const path = (req.url ?? '').split('?')[0] ?? '';
  const up: Upstream = { cfg, base: upstreamBase(cfg, opts.upstream) };
  if (req.method === 'POST' && path === MESSAGES_PATH) return handleMessages(req, res, up);
  if (req.method === 'POST' && path === COUNT_PATH) return handleCount(req, res, up);
  throw new ProxyError(404, 'not_found_error', 'not found');
}

function failed(res: ServerResponse, err: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  if (err instanceof ProxyError) {
    sendError(res, err.status, err.kind, err.message);
    return;
  }
  const message = err instanceof Error ? err.message : 'proxy failure';
  sendError(res, 502, 'api_error', `metro bedrock proxy: ${message}`);
}

export interface RunningProxy {
  port: number;
  server: Server;
  close: () => Promise<void>;
}

export function startBedrockProxy(
  cfg: BedrockConfig,
  opts: ProxyOptions,
): Promise<RunningProxy> {
  const server = createServer((req, res) => {
    route(req, res, cfg, opts).catch((err: unknown) => {
      failed(res, err);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      resolve({
        port,
        server,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => {
              done();
            });
          }),
      });
    });
  });
}
