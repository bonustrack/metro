import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { handleGatewayRequest, resetGatewayState, type GatewayDeps } from '../src/gateway/gateway.ts';
import { lastServed } from '../src/gateway/served.ts';
import { codexVersion } from '../src/gateway/codex-version.ts';
import { userAgent } from '../src/gateway/codex.ts';
import { usageSeen } from '../src/gateway/usage.ts';
import { encodeFrame } from '../src/gateway/eventstream.ts';
import { emptySetup, type Connection, type ModelSetup } from '../src/gateway/model-config.ts';
import { codexAccess, conn, connectionId, makeConnection, setupOf, use } from './model-fixture.ts';
import { afterSearch, firstTurn, secretFunction, TOOL_SEARCH_BETAS } from './tool-search-fixture.ts';

const CLAUDE_TOKEN = `sk-ant-oat01-${'c'.repeat(80)}`;
const SIGNED_OUT_TOKEN = `sk-ant-oat01-${'d'.repeat(80)}`;

interface Seen {
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

interface Fake {
  server: Server;
  base: string;
  seen: Seen[];
  answer: (req: Seen, res: ServerResponse) => void;
}

async function fake(answer: (req: Seen, res: ServerResponse) => void): Promise<Fake> {
  const box: Fake = { server: createServer(), base: '', seen: [], answer };
  box.server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const entry = { url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
      box.seen.push(entry);
      box.answer(entry, res);
    });
  });
  await new Promise<void>((r) => {
    box.server.listen(0, '127.0.0.1', r);
  });
  box.base = `http://127.0.0.1:${String((box.server.address() as AddressInfo).port)}`;
  return box;
}

const sse = (res: ServerResponse, events: string[]): void => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'x-upstream': 'yes' });
  for (const e of events) res.write(`event: ${e}\ndata: {"type":"${e}"}\n\n`);
  res.end();
};

const frame = (event: object): Buffer =>
  encodeFrame(
    { ':message-type': 'event', ':event-type': 'chunk', ':content-type': 'application/json' },
    Buffer.from(JSON.stringify({ bytes: Buffer.from(JSON.stringify(event)).toString('base64') })),
  );

let anthropic: Fake;
let bedrock: Fake;
let openrouter: Fake;
let registry: Fake;
let codexBackend: Fake;
const refreshes: { id: string; revision: number }[] = [];
const renewOnce = (c: Connection): Connection | null => (c.codex === null ? null : { ...c, revision: c.revision + 1, codex: { ...c.codex, accessToken: 'at-2' } });
let renewed: (c: Connection) => Connection | null = renewOnce;
const codexEvents = (): string[] => [
  JSON.stringify({ type: 'response.created', response: { id: 'resp_1' } }),
  JSON.stringify({ type: 'response.output_item.added', item: { id: 'rs_1', type: 'reasoning' } }),
  JSON.stringify({ type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', delta: 'thinking hard' }),
  JSON.stringify({ type: 'response.output_item.done', item: { id: 'rs_1', type: 'reasoning', encrypted_content: 'ENC' } }),
  JSON.stringify({ type: 'response.output_item.added', item: { id: 'msg_1', type: 'message' } }),
  JSON.stringify({ type: 'response.output_text.delta', item_id: 'msg_1', delta: 'Hel' }),
  JSON.stringify({ type: 'response.output_text.delta', item_id: 'msg_1', delta: 'lo' }),
  JSON.stringify({ type: 'response.output_item.done', item: { id: 'msg_1', type: 'message' } }),
  JSON.stringify({ type: 'response.output_item.added', item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'Bash' } }),
  JSON.stringify({ type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"command":"ls"}' }),
  JSON.stringify({ type: 'response.output_item.done', item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'Bash', arguments: '{"command":"ls"}' } }),
  JSON.stringify({ type: 'response.completed', response: { id: 'resp_1', usage: { input_tokens: 120, output_tokens: 9, input_tokens_details: { cached_tokens: 100 } } } }),
];
let gateway: Server;
let base = '';
let cfg: ModelSetup;

const deps: GatewayDeps = {
  setup: () => cfg,
  identify: (key) => key === 'mk_ok',
  anthropicBase: '',
  bedrockBase: '',
  openrouterBase: '',
};

beforeAll(async () => {
  anthropic = await fake((req, res) => {
    if (req.headers.authorization === `Bearer ${SIGNED_OUT_TOKEN}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired"}}');
    } else if (req.body.includes('"stream":true')) sse(res, ['message_start', 'message_stop']);
    else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ echo: JSON.parse(req.body) as unknown, auth: req.headers.authorization, beta: req.headers['anthropic-beta'], key: req.headers['x-metro-key'] ?? null, apiKey: req.headers['x-api-key'] ?? null }));
    }
  });
  bedrock = await fake((req, res) => {
    if (req.url.endsWith('/invoke-with-response-stream')) {
      res.writeHead(200, { 'content-type': 'application/vnd.amazon.eventstream' });
      res.write(frame({ type: 'message_start', message: { id: 'msg_1' } }));
      res.end(frame({ type: 'message_stop' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(req.url.endsWith('/count-tokens') ? '{"inputTokens":42}' : '{"id":"msg_2","type":"message"}');
  });
  openrouter = await fake((_req, res) => {
    sse(res, ['message_start', 'message_stop']);
  });
  codexBackend = await fake((req, res) => {
    if (req.headers.authorization === 'Bearer expired') {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"detail":"token expired"}');
      return;
    }
    if (req.url.startsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ models: [{ slug: 'gpt-5.3-codex', visibility: 'list' }, { slug: 'gpt-5.4', visibility: 'list' }] }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const data of codexEvents()) res.write(`data: ${data}\n\n`);
    res.end();
  });
  deps.codex = {
    base: codexBackend.base,
    refresh: (c) => {
      refreshes.push({ id: c.id, revision: c.revision });
      return Promise.resolve(renewed(c));
    },
  };
  deps.anthropicBase = anthropic.base;
  deps.bedrockBase = bedrock.base;
  deps.openrouterBase = openrouter.base;
  registry = await fake((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"version":"0.158.2"}');
  });
  process.env.METRO_CODEX_REGISTRY = registry.base;
  gateway = createServer((req, res) => {
    if (handleGatewayRequest(req, res, deps)) return;
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => {
    gateway.listen(0, '127.0.0.1', r);
  });
  base = `http://127.0.0.1:${String((gateway.address() as AddressInfo).port)}`;
});

afterAll(() => {
  delete process.env.METRO_CODEX_REGISTRY;
  for (const s of [anthropic.server, bedrock.server, openrouter.server, codexBackend.server, registry.server, gateway]) s.close();
});

beforeEach(() => {
  resetGatewayState();
  cfg = setupOf('anthropic', [
    makeConnection('anthropic', { claudeToken: CLAUDE_TOKEN }),
    makeConnection('bedrock', { region: 'eu-central-1', apiKey: 'aws-key' }),
    makeConnection('openrouter', { apiKey: 'or-key', model: 'openai/gpt-5.2-codex' }),
    makeConnection('codex', { model: 'gpt-5.3-codex', codex: codexAccess() }),
  ]);
  refreshes.length = 0;
  renewed = renewOnce;
  anthropic.seen.length = 0;
  codexBackend.seen.length = 0;
  bedrock.seen.length = 0;
  openrouter.seen.length = 0;
});

const post = (path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-metro-key': 'mk_ok', ...headers },
    body: JSON.stringify(body),
  });

const message = (model: string, stream = false): Record<string, unknown> => ({
  model,
  max_tokens: 8,
  stream,
  system: [{ type: 'text', text: 'attribution', cache_control: { type: 'ephemeral' } }],
  messages: [{ role: 'user', content: 'hi' }],
});

describe('who the gateway answers', () => {
  test('the warm-up probe needs no key, everything else needs the agent key, unknown paths are 404', async () => {
    expect((await fetch(`${base}/gateway/api/hello`, { method: 'HEAD' })).status).toBe(200);
    const bare = await fetch(`${base}/gateway/v1/messages`, { method: 'POST', body: '{}' });
    expect(bare.status).toBe(401);
    expect(((await bare.json()) as { error: { type: string } }).error.type).toBe('authentication_error');
    expect((await post('/gateway/v1/messages', {}, { 'x-metro-key': 'mk_wrong' })).status).toBe(401);
    expect((await post('/gateway/v1/other', {})).status).toBe(404);
    expect((await fetch(`${base}/elsewhere`)).status).toBe(404);
  });

  test('the agent key is refused when the request came through the box public address', async () => {
    const funneled = await post('/gateway/v1/messages', message('claude-sonnet-4-6'), { 'tailscale-funnel-request': '?1', 'x-forwarded-for': '203.0.113.7' });
    expect(funneled.status).toBe(401);
    const models = await fetch(`${base}/gateway/v1/models`, { headers: { 'x-metro-key': 'mk_ok', 'x-forwarded-host': 'metro-x.ts.net' } });
    expect(models.status).toBe(401);
    expect(anthropic.seen).toHaveLength(0);
  });
});

describe('the session on any connection', () => {
  test('a request on a Claude subscription is served, with no Agent SDK guard in the way', async () => {
    expect((await post('/gateway/v1/messages', message('claude-sonnet-5'), { authorization: 'Bearer claude-login' })).status).toBe(200);
    expect(anthropic.seen).toHaveLength(1);
  });

  test('a keyed request keeps the model and effort policy', async () => {
    cfg = setupOf('anthropic', [makeConnection('anthropic', { apiKey: 'sk-ant-key', model: 'claude-opus-5' })]);
    const body = { ...message('claude-sonnet-5'), output_config: { effort: 'high' } };
    expect((await post('/gateway/v1/messages', body, { authorization: 'Bearer claude-login' })).status).toBe(200);
    expect(anthropic.seen[0]?.headers['x-api-key']).toBe('sk-ant-key');
    expect(anthropic.seen[0]?.headers.authorization).toBeUndefined();
    expect(JSON.parse(anthropic.seen[0]?.body ?? '{}')).toMatchObject({ model: 'claude-opus-5', output_config: { effort: 'low' } });
  });

  test('no model set up for the agent is a 503 that names the Models page, and nothing reaches a provider', async () => {
    cfg = emptySetup();
    const res = await post('/gateway/v1/messages', message('claude-sonnet-5'), { authorization: 'Bearer claude-login' });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain("organization's Models page");
    expect(anthropic.seen).toHaveLength(0);
  });
});

describe('the Anthropic route', () => {
  test('forwards path, query, headers and body bytes, with the Claude subscription token as the only credential', async () => {
    const res = await post('/gateway/v1/messages?beta=true', message('claude-sonnet-5'), {
      authorization: 'Bearer sk-ant-oat-login',
      'x-api-key': 'sk-ant-client',
      'anthropic-beta': 'context-management-2025-06-27',
      'anthropic-version': '2023-06-01',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { echo: Record<string, unknown>; auth: string; beta: string; key: string | null; apiKey: string | null };
    expect(body.auth).toBe(`Bearer ${CLAUDE_TOKEN}`);
    expect(body.beta).toBe('context-management-2025-06-27,oauth-2025-04-20');
    expect(body.key).toBeNull();
    expect(body.apiKey).toBeNull();
    expect(body.echo).toEqual(message('claude-sonnet-5'));
    expect(anthropic.seen[0]?.url).toBe('/v1/messages?beta=true');
    expect(anthropic.seen[0]?.body).toBe(JSON.stringify(message('claude-sonnet-5')));
  });

  test("metro's own key standing in for a login never reaches Anthropic: the subscription token replaces it", async () => {
    const res = await post('/gateway/v1/messages', message('claude-sonnet-5'), { authorization: 'Bearer mk_ok', 'anthropic-beta': 'oauth-2025-04-20' });
    expect(res.status).toBe(200);
    expect(anthropic.seen[0]?.headers.authorization).toBe(`Bearer ${CLAUDE_TOKEN}`);
    expect(anthropic.seen[0]?.headers['anthropic-beta']).toBe('oauth-2025-04-20');
    expect(JSON.stringify(anthropic.seen[0]?.headers)).not.toContain('mk_ok');
  });

  test('a token Anthropic refuses is a 403 saying to sign in again on the Models page, never a 401', async () => {
    conn(cfg, 'anthropic').claudeToken = SIGNED_OUT_TOKEN;
    const res = await post('/gateway/v1/messages', message('claude-sonnet-5', true));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { type: string; message: string } };
    expect(body.error.type).toBe('permission_error');
    expect(body.error.message).toBe('Anthropic refused the Claude subscription anthropic: sign in again on the Models page');
    expect(anthropic.seen).toHaveLength(1);
  });

  test('a key on the page replaces Claude Code\'s own login, takes the oauth beta off, and pins the model', async () => {
    Object.assign(conn(cfg, 'anthropic'), { apiKey: 'sk-ant-page', claudeToken: '', model: 'claude-opus-5' });
    const res = await post('/gateway/v1/messages', message('claude-sonnet-5'), {
      authorization: 'Bearer sk-ant-oat-login',
      'anthropic-beta': 'oauth-2025-04-20,context-management-2025-06-27',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { auth?: string; beta: string; apiKey: string | null };
    expect(body.apiKey).toBe('sk-ant-page');
    expect(body.auth).toBeUndefined();
    expect(body.beta).toBe('context-management-2025-06-27');
    expect((JSON.parse(anthropic.seen[0]?.body ?? '{}') as { model: string }).model).toBe('claude-opus-5');
    await post('/gateway/v1/messages', message('claude-haiku-4-5-20251001'));
    expect((JSON.parse(anthropic.seen[1]?.body ?? '{}') as { model: string }).model).toBe('claude-haiku-4-5-20251001');
  });

  test('a chore with thinking switched off keeps running when the pinned model cannot switch thinking off', async () => {
    conn(cfg, 'anthropic').model = 'claude-opus-5-5';
    const chore = { ...message('claude-opus-5'), thinking: { type: 'disabled' }, output_config: { effort: 'high', format: { type: 'json_schema' } } };
    await post('/gateway/v1/messages', chore);
    const sent = JSON.parse(anthropic.seen[0]?.body ?? '{}') as Record<string, unknown>;
    expect(sent.model).toBe('claude-opus-5-5');
    expect(sent).not.toHaveProperty('thinking');
    conn(cfg, 'anthropic').model = 'claude-opus-5';
    await post('/gateway/v1/messages', chore);
    const kept = JSON.parse(anthropic.seen[1]?.body ?? '{}') as Record<string, unknown>;
    expect(kept.thinking).toEqual({ type: 'disabled', block_binding: { prefix_mismatch_behavior: 'drop_block' } });
  });

  test('a stream comes back as the same SSE, with the upstream headers, and an explicit prefix strips to the bare id', async () => {
    const res = await post('/gateway/v1/messages', message('anthropic:claude-opus-4-8', true));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(res.headers.get('x-upstream')).toBe('yes');
    const text = await res.text();
    expect(text).toContain('event: message_start');
    expect(text).toContain('event: message_stop');
    expect((JSON.parse(anthropic.seen[0]?.body ?? '{}') as { model: string }).model).toBe('claude-opus-4-8');
  });

  test('the main thread is asked to think less, a subagent to think more, and a chore is left alone', async () => {
    const perTurn = (effort: string): Record<string, unknown> => ({ role: 'system', output_config: { effort }, content: 'context' });
    const turn = { ...message('claude-sonnet-5'), output_config: { effort: 'high' }, thinking: { type: 'adaptive' }, messages: [{ role: 'user', content: 'hi' }, perTurn('high')] };
    await post('/gateway/v1/messages', turn);
    const main = JSON.parse(anthropic.seen[0]?.body ?? '{}') as Record<string, unknown>;
    expect(main.output_config).toEqual({ effort: 'low' });
    expect(main.messages).toEqual([{ role: 'user', content: 'hi' }, perTurn('low')]);
    expect(main.thinking).toEqual({ type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } });
    expect(String(anthropic.seen[0]?.headers['anthropic-beta'] ?? '')).toContain('thinking-binding-controls');
    await post('/gateway/v1/messages', turn, { 'x-claude-code-agent-id': 'a0248f42' });
    const sub = JSON.parse(anthropic.seen[1]?.body ?? '{}') as Record<string, unknown>;
    expect(sub.output_config).toEqual({ effort: 'max' });
    expect(sub.messages).toEqual([{ role: 'user', content: 'hi' }, perTurn('max')]);
    const chore = { ...turn, output_config: { effort: 'high', format: { type: 'json_schema' } }, thinking: { type: 'disabled' } };
    await post('/gateway/v1/messages', chore);
    expect((JSON.parse(anthropic.seen[2]?.body ?? '{}') as Record<string, unknown>).output_config).toEqual({ effort: 'high', format: { type: 'json_schema' } });
  });

  test('a request Anthropic refuses because metro shaped it is sent again exactly as Claude Code wrote it', async () => {
    const answer = anthropic.answer;
    let refused = 0;
    anthropic.answer = (_req, res) => {
      refused += 1;
      if (refused === 1) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end('{"type":"error","error":{"type":"invalid_request_error","message":"effort: max is not supported"}}');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    };
    try {
      const turn = { ...message('claude-sonnet-5'), output_config: { effort: 'high' }, thinking: { type: 'adaptive' } };
      const res = await post('/gateway/v1/messages', turn, { 'x-claude-code-agent-id': 'a1' });
      expect(res.status).toBe(200);
      await res.text();
      expect(anthropic.seen.length).toBe(2);
      expect(JSON.parse(anthropic.seen[1]?.body ?? '{}')).toEqual(turn);
    } finally {
      anthropic.answer = answer;
    }
  });

  test('the quota Anthropic states on the answer is kept for the Model page, never sent upstream and never asked for', async () => {
    const answer = anthropic.answer;
    anthropic.answer = (_req, res) => {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'anthropic-ratelimit-unified-5h-utilization': '0.34',
        'anthropic-ratelimit-unified-5h-status': 'allowed',
        'anthropic-ratelimit-unified-7d-utilization': '0.61',
      });
      res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    };
    try {
      expect(usageSeen()[connectionId('anthropic')]).toBeUndefined();
      const res = await post('/gateway/v1/messages', message('claude-opus-4-8', true));
      expect(res.status).toBe(200);
      await res.text();
      const seen = usageSeen()[connectionId('anthropic')];
      expect(seen?.windows.map((w) => [w.label, w.used])).toEqual([
        ['5-hour window', 0.34],
        ['Weekly, all models', 0.61],
      ]);
      expect(anthropic.seen.length).toBe(1);
    } finally {
      anthropic.answer = answer;
    }
  });
});

describe('the Bedrock route', () => {
  test('rewrites the request the way Bedrock wants it and turns the event stream into SSE', async () => {
    use(cfg, 'bedrock');
    const res = await post('/gateway/v1/messages', message('claude-sonnet-4-6', true), { 'anthropic-beta': 'interleaved-thinking-2025-05-14' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const text = await res.text();
    expect(text).toContain('event: message_start');
    expect(text).toContain('event: message_stop');
    const seen = bedrock.seen[0];
    expect(seen?.url).toBe('/model/eu.anthropic.claude-sonnet-4-6/invoke-with-response-stream');
    expect(seen?.headers.authorization).toBe('Bearer aws-key');
    const sent = JSON.parse(seen?.body ?? '{}') as Record<string, unknown>;
    expect(sent.anthropic_version).toBe('bedrock-2023-05-31');
    expect(sent.anthropic_beta).toEqual(['interleaved-thinking-2025-05-14']);
    expect(sent.model).toBeUndefined();
    expect(sent.stream).toBeUndefined();
  });

  test('counts tokens through Bedrock, and refuses by name when the page holds no key', async () => {
    use(cfg, 'bedrock');
    const count = await post('/gateway/v1/messages/count_tokens', message('claude-sonnet-4-6'));
    expect(await count.json()).toEqual({ input_tokens: 42 });
    conn(cfg, 'bedrock').apiKey = '';
    const refused = await post('/gateway/v1/messages', message('claude-sonnet-4-6'));
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: { message: string } }).error.message).toContain('Bedrock has no API key');
    expect(bedrock.seen.length).toBe(1);
  });
});

describe('the OpenRouter route', () => {
  test('sends the page model with the OpenRouter key, keeps an explicit id, and leaves token counting to Claude Code', async () => {
    use(cfg, 'openrouter');
    const res = await post('/gateway/v1/messages', message('claude-sonnet-5', true), { authorization: 'Bearer sk-ant-oat-login' });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('event: message_stop');
    const seen = openrouter.seen[0];
    expect(seen?.url).toBe('/v1/messages');
    expect(seen?.headers.authorization).toBe('Bearer or-key');
    expect((JSON.parse(seen?.body ?? '{}') as { model: string }).model).toBe('openai/gpt-5.2-codex');
    await post('/gateway/v1/messages', message('openrouter:google/gemini-2.5-pro'));
    expect((JSON.parse(openrouter.seen[1]?.body ?? '{}') as { model: string }).model).toBe('google/gemini-2.5-pro');
    expect((await post('/gateway/v1/messages/count_tokens', message('claude-sonnet-5'))).status).toBe(404);
    conn(cfg, 'openrouter').model = '';
    expect((await post('/gateway/v1/messages', message('claude-sonnet-5'))).status).toBe(400);
  });

  test('a request that switches thinking off loses that field, since some OpenRouter models cannot run without reasoning', async () => {
    use(cfg, 'openrouter');
    await post('/gateway/v1/messages', { ...message('claude-sonnet-5'), thinking: { type: 'disabled' } });
    expect(JSON.parse(openrouter.seen[0]?.body ?? '{}')).not.toHaveProperty('thinking');
    await post('/gateway/v1/messages', { ...message('claude-sonnet-5'), thinking: { type: 'enabled', budget_tokens: 1024 } });
    expect((JSON.parse(openrouter.seen[1]?.body ?? '{}') as { thinking: unknown }).thinking).toEqual({ type: 'enabled', budget_tokens: 1024 });
    conn(cfg, 'openrouter').zdr = true;
    await post('/gateway/v1/messages', { ...message('claude-sonnet-5'), thinking: { type: 'disabled' } });
    const sealed = JSON.parse(openrouter.seen[2]?.body ?? '{}') as Record<string, unknown>;
    expect(sealed).not.toHaveProperty('thinking');
    expect(sealed.provider).toEqual({ zdr: true });
    conn(cfg, 'openrouter').zdr = false;
  });

  test('the effort rides as OpenRouter\'s own reasoning field, capped at high because not every model goes further', async () => {
    use(cfg, 'openrouter');
    const turn = { ...message('claude-sonnet-5'), output_config: { effort: 'high' }, thinking: { type: 'adaptive' } };
    await post('/gateway/v1/messages', turn, { 'x-claude-code-agent-id': 'a1' });
    const sub = JSON.parse(openrouter.seen[0]?.body ?? '{}') as Record<string, unknown>;
    expect(sub.output_config).toEqual({ effort: 'max' });
    expect(sub.reasoning).toEqual({ effort: 'high' });
    await post('/gateway/v1/messages', turn);
    expect((JSON.parse(openrouter.seen[1]?.body ?? '{}') as Record<string, unknown>).reasoning).toEqual({ effort: 'low' });
    await post('/gateway/v1/messages', message('claude-sonnet-5'));
    expect(JSON.parse(openrouter.seen[2]?.body ?? '{}')).not.toHaveProperty('reasoning');
  });

  test('with zero data retention on, every request carries provider.zdr, merged into any routing the client sent', async () => {
    use(cfg, 'openrouter');
    conn(cfg, 'openrouter').zdr = true;
    await post('/gateway/v1/messages', message('claude-sonnet-5'));
    const plain = JSON.parse(openrouter.seen[0]?.body ?? '{}') as { provider?: Record<string, unknown> };
    expect(plain.provider).toEqual({ zdr: true });
    await post('/gateway/v1/messages', { ...message('claude-sonnet-5'), provider: { order: ['anthropic'], zdr: false } });
    const merged = JSON.parse(openrouter.seen[1]?.body ?? '{}') as { provider?: Record<string, unknown> };
    expect(merged.provider).toEqual({ order: ['anthropic'], zdr: true });
    conn(cfg, 'openrouter').zdr = false;
    await post('/gateway/v1/messages', message('claude-sonnet-5'));
    expect(JSON.parse(openrouter.seen[2]?.body ?? '{}')).not.toHaveProperty('provider');
  });
});

describe('what the picker can discover', () => {
  test('lists the models of the route under ids the picker keeps', async () => {
    cfg.primary = { connection: conn(cfg, 'bedrock').id, model: 'eu.anthropic.claude-sonnet-4-6' };
    cfg.fallbacks = [{ connection: conn(cfg, 'openrouter').id, model: 'openai/gpt-5.2-codex' }, { connection: conn(cfg, 'codex').id, model: 'gpt-5.3-codex' }, { connection: connectionId('anthropic'), model: 'claude-sonnet-5' }];
    const res = await fetch(`${base}/gateway/v1/models?limit=1000`, { headers: { 'x-metro-key': 'mk_ok' } });
    const body = (await res.json()) as { data: { id: string; display_name: string }[] };
    expect(body.data.map((m) => m.id)).toEqual(['bedrock:eu.anthropic.claude-sonnet-4-6', 'openrouter:openai/gpt-5.2-codex', 'codex:gpt-5.3-codex']);
    expect(body.data[0]?.display_name).toContain('bedrock');
  });
});

describe('the Codex route', () => {
  test('calls the public Responses API with the ChatGPT sign-in as its only credential, the system prompt as instructions, and translates the stream', async () => {
    use(cfg, 'codex');
    const res = await post('/gateway/v1/messages', { ...message('claude-sonnet-5', true), tools: [{ name: 'Bash', description: 'run', input_schema: { type: 'object' } }] }, { 'x-claude-code-session-id': 'sess-1' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const text = await res.text();
    expect(text).toContain('"type":"message_start"');
    expect(text).toContain('"thinking_delta","thinking":"thinking hard"');
    expect(text).toContain('"signature_delta","signature":"metro-codex:');
    expect(text).toContain('"text_delta","text":"Hel"');
    expect(text).toContain('"tool_use","id":"call_1","name":"Bash"');
    expect(text).toContain('"input_json_delta","partial_json":"{\\"command\\":\\"ls\\"}"');
    expect(text).toContain('"stop_reason":"tool_use"');
    expect(text).toContain('"input_tokens":20,"output_tokens":9,"cache_read_input_tokens":100');
    expect(text).toContain('event: message_stop');
    expect(codexBackend.seen.length).toBe(1);
    const sent = JSON.parse(codexBackend.seen[0]?.body ?? '{}') as { instructions: string; input: Record<string, unknown>[]; tools: Record<string, unknown>[]; model: string; store: boolean; stream: boolean; include: string[]; prompt_cache_key: string };
    expect(sent.instructions).toBe('attribution');
    expect(sent.input[0]).toMatchObject({ type: 'message', role: 'user' });
    expect(sent.tools[0]).toMatchObject({ type: 'function', name: 'Bash' });
    expect(sent).toMatchObject({ model: 'gpt-5.3-codex', store: false, stream: true, include: ['reasoning.encrypted_content'], prompt_cache_key: 'sess-1' });
    expect(codexBackend.seen[0]?.url).toBe('/responses');
    const headers = codexBackend.seen[0]?.headers ?? {};
    expect(headers.authorization).toBe('Bearer at-1');
    expect(headers.accept).toBe('text/event-stream');
    for (const name of ['chatgpt-account-id', 'originator', 'openai-beta', 'session-id']) expect(headers[name]).toBeUndefined();
    expect(String(headers['user-agent'])).not.toContain('codex');
  });

  test('an image Read returns reaches Codex inside its tool output', async () => {
    use(cfg, 'codex');
    const res = await post('/gateway/v1/messages', {
      ...message('gpt-5.4', true),
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'call_read', name: 'Read', input: { file_path: '/shot.png' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_read', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] }] },
      ],
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('event: message_stop');
    const sent = JSON.parse(codexBackend.seen[0]?.body ?? '{}') as { input: unknown[] };
    expect(sent.input).toEqual([
      { type: 'function_call', call_id: 'call_read', name: 'Read', arguments: '{"file_path":"/shot.png"}' },
      { type: 'function_call_output', call_id: 'call_read', output: [{ type: 'input_image', image_url: 'data:image/png;base64,AAAA' }] },
    ]);
  });

  test('a 401 asks api.metro.box once for a renewed sign-in with the revision it used, and retries with it', async () => {
    use(cfg, 'codex');
    Object.assign(conn(cfg, 'codex'), { revision: 3, codex: codexAccess({ accessToken: 'expired' }) });
    const res = await post('/gateway/v1/messages', message('gpt-5.4', true));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('event: message_stop');
    expect(refreshes).toEqual([{ id: conn(cfg, 'codex').id, revision: 3 }]);
    expect(codexBackend.seen.map((r) => r.headers.authorization)).toEqual(['Bearer expired', 'Bearer at-2']);
    expect((JSON.parse(codexBackend.seen.at(-1)?.body ?? '{}') as { model: string }).model).toBe('gpt-5.4');
  });

  test('a renewal api.metro.box cannot give is a 403 naming where to sign in again, and a second refusal is a 403 too', async () => {
    use(cfg, 'codex');
    conn(cfg, 'codex').codex = codexAccess({ accessToken: 'expired' });
    renewed = () => null;
    const refused = await post('/gateway/v1/messages', message('gpt-5.4'));
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: { type: string; message: string } }).error).toMatchObject({ type: 'permission_error', message: expect.stringContaining('Models page') });
    renewed = (c) => c;
    const again = await post('/gateway/v1/messages', message('gpt-5.4'));
    expect(again.status).toBe(403);
    await again.text();
    expect(refreshes).toHaveLength(2);
    expect(codexBackend.seen).toHaveLength(3);
  });

  test('a code sign-in calls the ChatGPT backend as the Codex app, and a 401 is renewed by api.metro.box', async () => {
    use(cfg, 'codex');
    conn(cfg, 'codex').codex = codexAccess({ method: 'code', accountId: 'acct_1', accessToken: 'expired' });
    const res = await post('/gateway/v1/messages', message('gpt-5.4', true), { 'x-claude-code-session-id': 'sess-2' });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('event: message_stop');
    expect(refreshes).toHaveLength(1);
    const last = codexBackend.seen.at(-1);
    expect(last?.url).toBe('/responses');
    expect(last?.headers).toMatchObject({ authorization: 'Bearer at-2', 'chatgpt-account-id': 'acct_1', originator: 'codex_cli_rs', 'openai-beta': 'responses=experimental', 'session-id': 'sess-2' });
    expect(String(last?.headers['user-agent'])).toMatch(/^codex_cli_rs\/\d+\.\d+\.\d+ \(.+\) metro$/);
    expect((JSON.parse(last?.body ?? '{}') as { model: string; prompt_cache_key: string })).toMatchObject({ model: 'gpt-5.4', prompt_cache_key: 'sess-2' });
  });

  test('a code sign-in announces the latest Codex CLI on npm, learned in the background, and an override wins', async () => {
    use(cfg, 'codex');
    conn(cfg, 'codex').codex = codexAccess({ method: 'code', accountId: 'acct_1' });
    await (await post('/gateway/v1/messages', message('gpt-5.4', true))).text();
    for (let tries = 0; tries < 50 && codexVersion() !== '0.158.2'; tries += 1) await Bun.sleep(10);
    await (await post('/gateway/v1/messages', message('gpt-5.4', true))).text();
    expect(String(codexBackend.seen.at(-1)?.headers['user-agent'])).toContain('codex_cli_rs/0.158.2');
    process.env.METRO_CODEX_VERSION = '0.160.0';
    try {
      expect(userAgent()).toContain('codex_cli_rs/0.160.0');
      process.env.METRO_CODEX_VERSION = 'not a version';
      expect(codexVersion()).toBe('0.158.2');
    } finally {
      delete process.env.METRO_CODEX_VERSION;
    }
  });

  test('a used-up ChatGPT plan is a 429 rate limit that says where to manage the usage', async () => {
    use(cfg, 'codex');
    const answer = codexBackend.answer;
    codexBackend.answer = (_req, res) => {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end('{"error":{"code":"subscription_sharing_usage_limit_exceeded","message":"Usage limit reached."}}');
    };
    try {
      const res = await post('/gateway/v1/messages', message('gpt-5.4', true));
      expect(res.status).toBe(429);
      expect(await res.json()).toEqual({ type: 'error', error: { type: 'rate_limit_error', message: 'Usage limit reached. Manage usage: https://chatgpt.com/settings/usage' } });
    } finally {
      codexBackend.answer = answer;
    }
  });

  test('token counting is an estimate, a disconnected account is a 400, and the picker sees the route', async () => {
    use(cfg, 'codex');
    const count = await post('/gateway/v1/messages/count_tokens', message('claude-sonnet-5'));
    expect(((await count.json()) as { input_tokens: number }).input_tokens).toBeGreaterThan(10);
    const models = await fetch(`${base}/gateway/v1/models`, { headers: { 'x-metro-key': 'mk_ok' } });
    expect(((await models.json()) as { data: { id: string }[] }).data.map((m) => m.id)).toContain('codex:gpt-5.3-codex');
    conn(cfg, 'codex').codex = null;
    const refused = await post('/gateway/v1/messages', message('claude-sonnet-5'));
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: { message: string } }).error.message).toContain('Models page');
    expect(refreshes).toHaveLength(0);
  });
});

describe('what keeps a session alive through a bad hour', () => {
  test('a provider that goes silent is cut off with an error frame instead of hanging behind the pings', async () => {
    const answer = openrouter.answer;
    openrouter.answer = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
    };
    process.env.METRO_GATEWAY_IDLE_MS = '300';
    try {
      const res = await post('/gateway/v1/messages', message('openrouter:x/y', true));
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('"type":"message_start"');
      expect(text).toContain('"type":"error","error":{"type":"api_error","message":"metro gateway: the provider sent nothing for 0s; giving up on this request"}');
    } finally {
      delete process.env.METRO_GATEWAY_IDLE_MS;
      openrouter.answer = answer;
    }
  });

  test('a provider refusing the stored credential is a 403, never a 401 that would make Claude Code drop its own login', async () => {
    const answer = openrouter.answer;
    openrouter.answer = (_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"error":{"message":"bad key"}}');
    };
    try {
      const res = await post('/gateway/v1/messages', message('openrouter:x/y'));
      expect(res.status).toBe(403);
      expect(await res.text()).toContain('bad key');
    } finally {
      openrouter.answer = answer;
    }
    use(cfg, 'codex');
    conn(cfg, 'codex').codex = null;
    expect((await post('/gateway/v1/messages', message('gpt-5.4'))).status).toBe(400);
  });
});

describe('what the Model page can show about traffic', () => {
  test('a served message is remembered with its route, a token count is not, and a reset forgets it', async () => {
    expect(lastServed()).toBeNull();
    await post('/gateway/v1/messages', message('claude-sonnet-5'));
    expect(lastServed()).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-5' });
    expect(Date.parse(lastServed()?.at ?? '')).toBeGreaterThan(0);
    await post('/gateway/v1/messages', message('bedrock:eu.anthropic.claude-sonnet-4-6'));
    expect(lastServed()).toMatchObject({ provider: 'bedrock', model: 'eu.anthropic.claude-sonnet-4-6' });
    const before = lastServed();
    await post('/gateway/v1/messages/count_tokens', message('claude-sonnet-5'));
    expect(lastServed()).toEqual(before);
    resetGatewayState();
    expect(lastServed()).toBeNull();
  });
});

describe('MCP tool search', () => {
  const FLAT_BETAS = 'claude-code-20250219,interleaved-thinking-2025-05-14,context-management-2025-06-27,effort-2025-11-24';
  const names = (tools: { name: string }[]): string[] => tools.map((t) => t.name);
  const searchedByMetro = (sent: { tools?: { name: string }[]; messages?: unknown }): void => {
    expect(names(sent.tools ?? [])).toEqual(['ToolSearch', 'mcp__probe__pinned', 'mcp__probe__secret_word']);
    const text = JSON.stringify(sent.messages);
    expect(text).not.toContain('tool_reference');
    expect(text).toContain(JSON.stringify(`<functions>\n${secretFunction}\n</functions>`).slice(1, -1));
    expect(JSON.stringify(sent)).not.toContain('defer_loading');
  };

  test('the Anthropic route gets the search done by metro like every route, without the tool search beta', async () => {
    await post('/gateway/v1/messages?beta=true', afterSearch('claude-sonnet-5'), { authorization: 'Bearer sk-ant-oat-login', 'anthropic-beta': `oauth-2025-04-20,${TOOL_SEARCH_BETAS}` });
    searchedByMetro(JSON.parse(anthropic.seen[0]?.body ?? '{}') as Record<string, never>);
    expect(anthropic.seen[0]?.headers['anthropic-beta']).toBe(`oauth-2025-04-20,${FLAT_BETAS}`);
    expect(anthropic.seen[0]?.headers.authorization).toBe(`Bearer ${CLAUDE_TOKEN}`);
    Object.assign(conn(cfg, 'anthropic'), { apiKey: 'sk-ant-page' });
    await post('/gateway/v1/messages', afterSearch('claude-opus-5-5'), { 'anthropic-beta': TOOL_SEARCH_BETAS });
    searchedByMetro(JSON.parse(anthropic.seen[1]?.body ?? '{}') as Record<string, never>);
    expect(anthropic.seen[1]?.headers['anthropic-beta']).toBe(FLAT_BETAS);
  });

  test('before any search every route sees ToolSearch and the always-loaded tools only', async () => {
    await post('/gateway/v1/messages', firstTurn('claude-sonnet-5'), { authorization: 'Bearer sk-ant-oat-login', 'anthropic-beta': TOOL_SEARCH_BETAS });
    expect(names((JSON.parse(anthropic.seen[0]?.body ?? '{}') as { tools: { name: string }[] }).tools)).toEqual(['ToolSearch', 'mcp__probe__pinned']);
    use(cfg, 'openrouter');
    await post('/gateway/v1/messages', firstTurn('claude-sonnet-5'), { 'anthropic-beta': TOOL_SEARCH_BETAS });
    expect(names((JSON.parse(openrouter.seen[0]?.body ?? '{}') as { tools: { name: string }[] }).tools)).toEqual(['ToolSearch', 'mcp__probe__pinned']);
  });

  test('a request with nothing deferred reaches Anthropic byte for byte', async () => {
    const raw = JSON.stringify(message('claude-sonnet-5'), null, 1);
    const res = await fetch(`${base}/gateway/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-metro-key': 'mk_ok', authorization: 'Bearer sk-ant-oat-login' },
      body: raw,
    });
    await res.text();
    expect(anthropic.seen[0]?.body).toBe(raw);
  });

  test('a model that refuses what metro shaped is asked again with the search still done by metro', async () => {
    Object.assign(conn(cfg, 'anthropic'), { apiKey: 'sk-ant-page', model: 'claude-opus-4-1-20250805' });
    const answer = anthropic.answer;
    let refused = 0;
    anthropic.answer = (_req, res) => {
      refused += 1;
      if (refused === 1) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end('{"type":"error","error":{"type":"invalid_request_error","message":"effort: max is not supported"}}');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    };
    try {
      const turn = { ...afterSearch('claude-sonnet-5'), output_config: { effort: 'high' } };
      const res = await post('/gateway/v1/messages', turn, { 'x-claude-code-agent-id': 'a1', 'anthropic-beta': TOOL_SEARCH_BETAS });
      expect(res.status).toBe(200);
      await res.text();
      expect(anthropic.seen.length).toBe(2);
      const again = JSON.parse(anthropic.seen[1]?.body ?? '{}') as Record<string, never>;
      searchedByMetro(again);
      expect(again.output_config).toEqual({ effort: 'high' });
      expect(again.model).toBe('claude-opus-4-1-20250805');
    } finally {
      anthropic.answer = answer;
    }
  });

  test('Bedrock and OpenRouter get the found tool as a plain tool, and never the tool search beta', async () => {
    use(cfg, 'bedrock');
    await post('/gateway/v1/messages', afterSearch('claude-sonnet-4-6'), { 'anthropic-beta': TOOL_SEARCH_BETAS });
    const rock = JSON.parse(bedrock.seen[0]?.body ?? '{}') as Record<string, never>;
    searchedByMetro(rock);
    expect(rock.anthropic_beta).toEqual(FLAT_BETAS.split(','));
    use(cfg, 'openrouter');
    await post('/gateway/v1/messages', afterSearch('claude-sonnet-5'), { 'anthropic-beta': 'advanced-tool-use-2025-11-20' });
    searchedByMetro(JSON.parse(openrouter.seen[0]?.body ?? '{}') as Record<string, never>);
    expect(openrouter.seen[0]?.headers['anthropic-beta']).toBeUndefined();
  });

  test('Codex gets the found tool as a function and the search result as the <functions> block', async () => {
    use(cfg, 'codex');
    await post('/gateway/v1/messages', { ...afterSearch('claude-sonnet-5'), stream: true }, { 'anthropic-beta': TOOL_SEARCH_BETAS });
    const sent = JSON.parse(codexBackend.seen[0]?.body ?? '{}') as { tools: { name: string }[]; input: Record<string, unknown>[] };
    expect(names(sent.tools)).toEqual(['ToolSearch', 'mcp__probe__pinned', 'mcp__probe__secret_word']);
    expect(sent.input.find((item) => item.type === 'function_call_output')).toEqual({ type: 'function_call_output', call_id: 'toolu_search1', output: `<functions>\n${secretFunction}\n</functions>` });
  });
});
