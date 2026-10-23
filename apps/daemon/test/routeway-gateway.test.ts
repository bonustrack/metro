import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomInt } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGatewayRequest, resetGatewayState, type GatewayDeps } from '../src/gateway/gateway.ts';
import { BINDING_BETA } from '../src/gateway/effort.ts';
import { resolveRoute, runnerModel, type ModelSetup } from '../src/gateway/model-config.ts';
import { connectionId, makeConnection, setupOf } from './model-fixture.ts';

const KEY = 'routeway-test-key';
const ROUTEWAY = connectionId('routeway');

interface Seen {
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}

interface Upstream {
  server: Server;
  base: string;
  seen: Seen[];
}

const jsonReply = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};

function routewayAnswer(seen: Seen, res: ServerResponse): void {
  const body = JSON.parse(seen.body) as { model?: string; stream?: boolean; output_config?: { effort?: string } };
  if (body.model === 'walled') {
    res.writeHead(429, { 'content-type': 'text/html; charset=UTF-8' });
    res.end('<!DOCTYPE html><title>Too many requests</title>');
    return;
  }
  if (body.model === 'challenged') {
    res.writeHead(403, { 'content-type': 'text/html; charset=UTF-8' });
    res.end('<!DOCTYPE html><title>Just a moment...</title>');
    return;
  }
  if (seen.headers['x-api-key'] !== KEY) return jsonReply(res, 401, { error: { message: 'Invalid API key', type: 'authentication_error', code: 'invalid_api_key' } });
  if (body.model === 'busy') return jsonReply(res, 429, { error: { message: 'rate limited', type: 'rate_limit_error' } }, { 'retry-after': '30' });
  if (body.model === 'broke') return jsonReply(res, 402, { error: { message: 'no credit left', type: 'billing_error' } });
  if (body.model === 'picky' && body.output_config?.effort === 'low') return jsonReply(res, 400, { error: { message: 'effort low is not supported', type: 'invalid_request_error' } });
  if (body.stream === true) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":12,"output_tokens":1}}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n');
    return;
  }
  jsonReply(res, 200, { type: 'message', model: body.model, usage: { input_tokens: 12, output_tokens: 3 } });
}

async function upstream(answer: (seen: Seen, res: ServerResponse) => void): Promise<Upstream> {
  const held: Upstream = { server: createServer(), base: '', seen: [] };
  held.server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const seen = { url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
      held.seen.push(seen);
      answer(seen, res);
    });
  });
  held.base = await listen(held.server);
  return held;
}

async function listen(server: Server): Promise<string> {
  const port = randomInt(10_000, 30_000);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${String(port)}`;
}

let routeway: Upstream;
let anthropic: Upstream;
let gateway: Server;
let base = '';
let cfg: ModelSetup;
const deps: GatewayDeps = { setup: () => cfg, identify: (key) => key === 'mk_ok' };

beforeAll(async () => {
  routeway = await upstream(routewayAnswer);
  anthropic = await upstream((_seen, res) => {
    jsonReply(res, 200, { type: 'message', served: 'anthropic' });
  });
  deps.routewayBase = routeway.base;
  deps.anthropicBase = anthropic.base;
  gateway = createServer((req, res) => {
    if (!handleGatewayRequest(req, res, deps)) res.writeHead(404).end();
  });
  base = await listen(gateway);
});

afterAll(() => {
  for (const server of [routeway.server, anthropic.server, gateway]) server.close();
});

beforeEach(() => {
  resetGatewayState();
  routeway.seen.length = 0;
  anthropic.seen.length = 0;
  cfg = setupOf('routeway', [makeConnection('routeway', { apiKey: KEY, model: 'claude-sonnet-5.5', label: 'Routeway' }), makeConnection('anthropic', { apiKey: 'sk-ant-key' })]);
});

const send = (path: string, body: string, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(`${base}/gateway${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-metro-key': 'mk_ok', authorization: 'Bearer stand-in', 'anthropic-version': '2023-06-01', ...headers },
    body,
  });

const ask = (model: string, extra: Record<string, unknown> = {}): string => JSON.stringify({ model, max_tokens: 8, messages: [{ role: 'user', content: 'hi' }], ...extra });

const sentModel = (seen: Seen | undefined): unknown => (JSON.parse(seen?.body ?? '{}') as { model?: unknown }).model;

describe('a Routeway connection', () => {
  test('carries the stored key as x-api-key, never the client authorization or the agent key, and keeps the version and the betas', async () => {
    const res = await send('/v1/messages?beta=true', ask('routeway:claude-sonnet-5.5'), { 'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20', 'user-agent': 'claude-cli/2.1.289 (external, sdk-ts)' });
    expect(res.status).toBe(200);
    const [seen] = routeway.seen;
    expect(seen?.url).toBe('/v1/messages?beta=true');
    expect(seen?.headers['x-api-key']).toBe(KEY);
    expect(seen?.headers.authorization).toBeUndefined();
    expect(seen?.headers['x-metro-key']).toBeUndefined();
    expect(seen?.headers['anthropic-version']).toBe('2023-06-01');
    expect(seen?.headers['anthropic-beta']).toBe('claude-code-20250219');
    expect(seen?.headers['user-agent']).toBe('claude-cli/2.1.289 (external, sdk-ts)');
    expect(sentModel(seen)).toBe('claude-sonnet-5.5');
    expect(anthropic.seen).toHaveLength(0);
  });

  test('gets the five-minute cache it got before the one-hour cache, never its ttl or beta', async () => {
    const system = [{ type: 'text', text: 'rules', cache_control: { type: 'ephemeral', ttl: '1h' } }];
    const messages = [{ role: 'user', content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral', ttl: '1h' } }] }];
    await send('/v1/messages', ask('routeway:claude-sonnet-5.5', { system, messages }), { 'anthropic-beta': 'claude-code-20250219,extended-cache-ttl-2025-04-11' });
    const [seen] = routeway.seen;
    const sent = JSON.parse(seen?.body ?? '{}') as Record<string, unknown>;
    expect(sent.system).toEqual([{ type: 'text', text: 'rules', cache_control: { type: 'ephemeral' } }]);
    expect(sent.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }] }]);
    expect(seen?.headers['anthropic-beta']).toBe('claude-code-20250219');
  });

  test('sends the body byte for byte when metro changes nothing, and names the routed model when the request asks for another one', async () => {
    const raw = '{ "max_tokens":8,  "model":"claude-sonnet-5.5", "messages":[{"role":"user","content":"hi"}] }';
    await send('/v1/messages', raw);
    expect(routeway.seen[0]?.body).toBe(raw);
    await send('/v1/messages', ask('routeway:deepseek-v4-flash:free'));
    expect(sentModel(routeway.seen[1])).toBe('deepseek-v4-flash:free');
    await send('/v1/messages', ask('claude-haiku-4-5-20251001', { thinking: { type: 'disabled' } }));
    expect(sentModel(routeway.seen[2])).toBe('claude-sonnet-5.5');
  });

  test('a tool schema without properties gets an empty one, since Routeway refuses it, and a full schema is left as it is', async () => {
    const tools = [{ name: 'list_accounts', description: 'd', input_schema: { type: 'object' } }, { name: 'react', description: 'r', input_schema: { type: 'object', properties: { emoji: { type: 'string' } } } }];
    expect((await send('/v1/messages', ask('routeway:claude-sonnet-5.5', { tools }))).status).toBe(200);
    const sentTools = (JSON.parse(routeway.seen[0]?.body ?? '{}') as { tools: { input_schema: Record<string, unknown> }[] }).tools;
    expect(sentTools[0]?.input_schema).toEqual({ type: 'object', properties: {} });
    expect(sentTools[1]?.input_schema).toEqual(tools[1]?.input_schema);
  });

  test('a list of types becomes anyOf at every depth, since Routeway takes one type per field', async () => {
    const schema = {
      type: 'object',
      properties: {
        limit: { type: ['integer', 'null'], description: 'How many.' },
        only: { type: ['string'] },
        filter: { type: 'object', properties: { tags: { type: 'array', items: { type: ['string', 'number'] } } } },
        mixed: { type: ['string', 'null'], anyOf: [{ minLength: 1 }, { const: null }] },
      },
    };
    await send('/v1/messages', ask('routeway:claude-sonnet-5.5', { tools: [{ name: 'read', description: 'r', input_schema: schema }] }));
    const sent = (JSON.parse(routeway.seen[0]?.body ?? '{}') as { tools: { input_schema: { properties: Record<string, unknown> } }[] }).tools[0]?.input_schema.properties;
    expect(sent?.limit).toEqual({ description: 'How many.', anyOf: [{ type: 'integer' }, { type: 'null' }] });
    expect(sent?.only).toEqual({ type: 'string' });
    expect(sent?.filter).toEqual({ type: 'object', properties: { tags: { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'number' }] } } } });
    expect(sent?.mixed).toEqual({ allOf: [{ anyOf: [{ type: 'string' }, { type: 'null' }] }, { anyOf: [{ minLength: 1 }, { const: null }] }] });
  });

  test('a body with nothing to fit is sent byte for byte even with tools', async () => {
    const raw = '{"model":"claude-sonnet-5.5","max_tokens":8,"tools":[{"name":"a","description":"b","input_schema":{"type":"object","properties":{"x":{"type":"string"}}}}],"messages":[{"role":"user","content":"hi"}]}';
    await send('/v1/messages', raw);
    expect(routeway.seen[0]?.body).toBe(raw);
  });

  test('counts tokens at Routeway too, with the same credential', async () => {
    expect((await send('/v1/messages/count_tokens', ask('routeway:claude-sonnet-5.5'))).status).toBe(200);
    expect(routeway.seen[0]?.url).toBe('/v1/messages/count_tokens');
    expect(routeway.seen[0]?.headers['x-api-key']).toBe(KEY);
  });

  test('a key Routeway refuses is answered 403, never 401', async () => {
    cfg.connections[0] = makeConnection('routeway', { apiKey: 'routeway-revoked-key', model: 'claude-sonnet-5.5' });
    const res = await send('/v1/messages', ask('routeway:claude-sonnet-5.5'));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe('Invalid API key');
  });

  test('a web page instead of the API is an upstream error, not a refused key', async () => {
    const res = await send('/v1/messages', ask('routeway:challenged'));
    expect(res.status).toBe(502);
    const error = ((await res.json()) as { error: { type: string; message: string } }).error;
    expect(error.type).toBe('api_error');
    expect(error.message).toContain('Routeway answered with a web page instead of its API (403)');
  });

  test('applies the effort policy, falls back to what Claude Code sent on a 400, and never adds the Anthropic binding beta', async () => {
    const thinking = { type: 'enabled', budget_tokens: 1024 };
    expect((await send('/v1/messages', ask('routeway:picky', { output_config: { effort: 'high' }, thinking }))).status).toBe(200);
    const efforts = routeway.seen.map((seen) => (JSON.parse(seen.body) as { output_config: { effort: string } }).output_config.effort);
    expect(efforts).toEqual(['low', 'high']);
    for (const seen of routeway.seen) {
      expect(seen.body).not.toContain('block_binding');
      expect(seen.headers['anthropic-beta'] ?? '').not.toContain(BINDING_BETA);
    }
  });

  test('streams the answer through and counts its tokens', async () => {
    const res = await send('/v1/messages', ask('routeway:claude-sonnet-5.5', { stream: true }));
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(await res.text()).toContain('message_stop');
  });

  test('a model without a key is not sent anywhere', async () => {
    cfg.connections[0] = makeConnection('routeway', { model: 'claude-sonnet-5.5' });
    const res = await send('/v1/messages', ask('routeway:claude-sonnet-5.5'));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain('Routeway has no API key');
    expect(routeway.seen).toHaveLength(0);
  });
});

describe('Routeway in the chain of models', () => {
  test('a 429 or a 402 hands the same request to the next model, and the last refusal is relayed as it came', async () => {
    cfg.primary = { connection: ROUTEWAY, model: 'busy' };
    cfg.fallbacks = [{ connection: ROUTEWAY, model: 'broke' }, { connection: ROUTEWAY, model: 'claude-sonnet-5.5' }];
    const res = await send('/v1/messages', ask('routeway:busy'));
    expect(res.status).toBe(200);
    expect(routeway.seen.map(sentModel)).toEqual(['busy', 'broke', 'claude-sonnet-5.5']);
    resetGatewayState();
    routeway.seen.length = 0;
    cfg.fallbacks = [{ connection: ROUTEWAY, model: 'broke' }];
    const last = await send('/v1/messages', ask('routeway:busy'));
    expect(last.status).toBe(402);
    expect(routeway.seen.map(sentModel)).toEqual(['busy', 'broke']);
  });

  test('a 429 web page from Routeway still hands the request to the next model', async () => {
    cfg.primary = { connection: ROUTEWAY, model: 'walled' };
    cfg.fallbacks = [{ connection: connectionId('anthropic'), model: 'claude-sonnet-5-5' }];
    const res = await send('/v1/messages', ask('routeway:walled'));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { served?: string }).served).toBe('anthropic');
  });

  test('a main model whose connection was not delivered gives way to the first backup that was', async () => {
    cfg.primary = { connection: 'unknown-provider-connection', model: 'some-model' };
    cfg.fallbacks = [{ connection: ROUTEWAY, model: 'claude-sonnet-5.5' }];
    expect(runnerModel(cfg)).toBe('routeway:claude-sonnet-5.5');
    expect((await send('/v1/messages', ask('claude-opus-5-5'))).status).toBe(200);
    expect(routeway.seen.map(sentModel)).toEqual(['claude-sonnet-5.5']);
  });

  test('Routeway and Anthropic hand over to each other', async () => {
    cfg.primary = { connection: ROUTEWAY, model: 'busy' };
    cfg.fallbacks = [{ connection: connectionId('anthropic'), model: 'claude-sonnet-5-5' }];
    expect(((await (await send('/v1/messages', ask('routeway:busy'))).json()) as { served?: string }).served).toBe('anthropic');
    expect(anthropic.seen[0]?.headers['x-api-key']).toBe('sk-ant-key');
  });

  test('the routed model reads routeway:<id> for the runner and the model list, and an id with a colon stays whole', async () => {
    expect(runnerModel(cfg)).toBe('routeway:claude-sonnet-5.5');
    expect(resolveRoute('routeway:deepseek-v4-flash:free', cfg)?.model).toBe('deepseek-v4-flash:free');
    expect(resolveRoute('claude-opus-5-5', cfg)?.model).toBe('claude-sonnet-5.5');
    const listed = (await (await fetch(`${base}/gateway/v1/models`, { headers: { 'x-metro-key': 'mk_ok' } })).json()) as { data: { id: string }[] };
    expect(listed.data.map((m) => m.id)).toEqual(['routeway:claude-sonnet-5.5']);
  });
});
