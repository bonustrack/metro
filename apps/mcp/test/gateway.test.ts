import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { handleGatewayRequest, resetGatewayState, type GatewayDeps } from '../src/gateway/gateway.ts';
import { lastServed } from '../src/gateway/served.ts';
import { encodeFrame } from '../src/gateway/eventstream.ts';
import type { ModelConfig } from '../src/gateway/model-config.ts';
import type { CodexTokens } from '../src/gateway/codex-auth.ts';

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
let codexBackend: Fake;
let tokenIssuer: Fake;
const saved: CodexTokens[] = [];
const jwt = (claims: Record<string, unknown>): string => ['e30', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'sig'].join('.');
const tokens = (): CodexTokens => ({ accessToken: 'at-1', refreshToken: 'rt-1', idToken: '', accountId: 'acct_1', email: 'less@example.com', plan: 'pro', savedAt: new Date().toISOString() });
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
let cfg: ModelConfig;

const deps: GatewayDeps = {
  config: () => cfg,
  identify: (key) => key === 'mk_ok',
  anthropicBase: '',
  bedrockBase: '',
  openrouterBase: '',
};

beforeAll(async () => {
  anthropic = await fake((req, res) => {
    if (req.body.includes('"stream":true')) sse(res, ['message_start', 'message_stop']);
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
      res.end(JSON.stringify({ models: [{ slug: 'gpt-5.3-codex' }, { slug: 'gpt-5.4' }] }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const data of codexEvents()) res.write(`data: ${data}\n\n`);
    res.end();
  });
  tokenIssuer = await fake((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ access_token: 'at-2', refresh_token: 'rt-2', id_token: jwt({ email: 'less@example.com', 'https://api.openai.com/auth': { chatgpt_account_id: 'acct_1', chatgpt_plan_type: 'pro' } }) }));
  });
  deps.codex = { base: codexBackend.base, issuer: tokenIssuer.base, save: (t) => { saved.push(t); } };
  deps.anthropicBase = anthropic.base;
  deps.bedrockBase = bedrock.base;
  deps.openrouterBase = openrouter.base;
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
  for (const s of [anthropic.server, bedrock.server, openrouter.server, codexBackend.server, tokenIssuer.server, gateway]) s.close();
});

beforeEach(() => {
  resetGatewayState();
  cfg = {
    version: 1,
    anthropic: { apiKey: '', model: '' },
    provider: 'anthropic',
    bedrock: { region: 'eu-central-1', apiKey: 'aws-key', model: '' },
    openrouter: { apiKey: 'or-key', model: 'openai/gpt-5.2-codex' },
    codex: { model: 'gpt-5.3-codex', auth: tokens() },
  };
  anthropic.seen.length = 0;
  codexBackend.seen.length = 0;
  tokenIssuer.seen.length = 0;
  saved.length = 0;
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
});

describe('the Anthropic route', () => {
  test('forwards the request as Claude Code sent it: path, query, headers, body bytes, and the login', async () => {
    const res = await post('/gateway/v1/messages?beta=true', message('claude-sonnet-5'), {
      authorization: 'Bearer sk-ant-oat-login',
      'anthropic-beta': 'oauth-2025-04-20,context-management-2025-06-27',
      'anthropic-version': '2023-06-01',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { echo: Record<string, unknown>; auth: string; beta: string; key: string | null };
    expect(body.auth).toBe('Bearer sk-ant-oat-login');
    expect(body.beta).toBe('oauth-2025-04-20,context-management-2025-06-27');
    expect(body.key).toBeNull();
    expect(body.echo).toEqual(message('claude-sonnet-5'));
    expect(anthropic.seen[0]?.url).toBe('/v1/messages?beta=true');
    expect(anthropic.seen[0]?.body).toBe(JSON.stringify(message('claude-sonnet-5')));
  });

  test('a key on the page replaces Claude Code\'s own login, takes the oauth beta off, and pins the model', async () => {
    cfg.anthropic = { apiKey: 'sk-ant-page', model: 'claude-opus-5' };
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
});

describe('the Bedrock route', () => {
  test('rewrites the request the way Bedrock wants it and turns the event stream into SSE', async () => {
    cfg.provider = 'bedrock';
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
    cfg.provider = 'bedrock';
    const count = await post('/gateway/v1/messages/count_tokens', message('claude-sonnet-4-6'));
    expect(await count.json()).toEqual({ input_tokens: 42 });
    cfg.bedrock.apiKey = '';
    const refused = await post('/gateway/v1/messages', message('claude-sonnet-4-6'));
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: { message: string } }).error.message).toContain('Model page');
    expect(bedrock.seen.length).toBe(1);
  });
});

describe('the OpenRouter route', () => {
  test('sends the page model with the OpenRouter key, keeps an explicit id, and leaves token counting to Claude Code', async () => {
    cfg.provider = 'openrouter';
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
    cfg.openrouter.model = '';
    expect((await post('/gateway/v1/messages', message('claude-sonnet-5'))).status).toBe(400);
  });
});

describe('what the picker can discover', () => {
  test('lists the configured routes under ids the picker keeps', async () => {
    cfg.bedrock.model = 'eu.anthropic.claude-sonnet-4-6';
    const res = await fetch(`${base}/gateway/v1/models?limit=1000`, { headers: { 'x-metro-key': 'mk_ok' } });
    const body = (await res.json()) as { data: { id: string; display_name: string }[] };
    expect(body.data.map((m) => m.id)).toEqual(['bedrock:eu.anthropic.claude-sonnet-4-6', 'openrouter:openai/gpt-5.2-codex', 'codex:gpt-5.3-codex']);
    expect(body.data[0]?.display_name).toContain('Bedrock');
  });
});

describe('the Codex route', () => {
  test('speaks the Codex CLI protocol with Claude Code\'s system prompt as its instructions, and translates the stream', async () => {
    cfg.provider = 'codex';
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
    const headers = codexBackend.seen[0]?.headers ?? {};
    expect(headers.authorization).toBe('Bearer at-1');
    expect(headers['chatgpt-account-id']).toBe('acct_1');
    expect(headers.originator).toBe('codex_cli_rs');
    expect(headers['session-id']).toBe('sess-1');
    expect(String(headers['user-agent'])).toMatch(/^codex_cli_rs\//);
  });

  test('a 401 refreshes the ChatGPT tokens once, saves them, and retries', async () => {
    cfg.provider = 'codex';
    cfg.codex.auth = { ...tokens(), accessToken: 'expired' };
    const res = await post('/gateway/v1/messages', message('gpt-5.4', true));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('event: message_stop');
    expect(tokenIssuer.seen.length).toBe(1);
    expect(JSON.parse(tokenIssuer.seen[0]?.body ?? '{}')).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'rt-1', client_id: 'app_EMoamEEZ73f0CkXaXp7hrann' });
    expect(saved[0]?.accessToken).toBe('at-2');
    expect(codexBackend.seen.at(-1)?.headers.authorization).toBe('Bearer at-2');
    expect((JSON.parse(codexBackend.seen.at(-1)?.body ?? '{}') as { model: string }).model).toBe('gpt-5.4');
  });

  test('token counting is an estimate, a disconnected account is a 400, and the picker sees the route', async () => {
    cfg.provider = 'codex';
    const count = await post('/gateway/v1/messages/count_tokens', message('claude-sonnet-5'));
    expect(((await count.json()) as { input_tokens: number }).input_tokens).toBeGreaterThan(10);
    cfg.codex.auth = null;
    const refused = await post('/gateway/v1/messages', message('claude-sonnet-5'));
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: { message: string } }).error.message).toContain('Model page');
    const models = await fetch(`${base}/gateway/v1/models`, { headers: { 'x-metro-key': 'mk_ok' } });
    expect(((await models.json()) as { data: { id: string }[] }).data.map((m) => m.id)).toContain('codex:gpt-5.3-codex');
  });
});

describe('what keeps a session alive through a bad hour', () => {
  test('two requests hitting an expired ChatGPT token share ONE refresh', async () => {
    cfg.provider = 'codex';
    cfg.codex.auth = { ...tokens(), accessToken: 'expired', savedAt: new Date(Date.now() - 5_000).toISOString() };
    const before = tokenIssuer.seen.length;
    const [a, b] = await Promise.all([post('/gateway/v1/messages', message('gpt-5.4', true)), post('/gateway/v1/messages', message('gpt-5.4', true))]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect((await a.text()).endsWith('event: message_stop\ndata: {"type":"message_stop"}\n\n')).toBe(true);
    await b.text();
    expect(tokenIssuer.seen.length - before).toBe(1);
  });

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
    cfg.provider = 'codex';
    cfg.codex.auth = null;
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
