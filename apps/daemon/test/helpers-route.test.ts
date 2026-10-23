import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomInt } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { encodeFrame } from '../src/gateway/eventstream.ts';
import { handleGatewayRequest, resetGatewayState, type GatewayDeps } from '../src/gateway/gateway.ts';
import { holdOf } from '../src/gateway/fallback.ts';
import { runnerModel, type Chain, type ModelSetup, type Provider } from '../src/gateway/model-config.ts';
import { codexAccess, connectionId, makeConnection } from './model-fixture.ts';
import { HELPER_HEADERS, helperCompaction, helperTurn, mainCompaction } from './compaction-fixture.ts';

interface Seen {
  model: string;
  effort: string | null;
  reasoning: string | null;
}

interface Upstream {
  server: Server;
  base: string;
  seen: Seen[];
}

const LIMITED = new Set(['busy-model']);
const HELPER = { 'x-claude-code-agent-id': 'worker-1' };

const codexEvents = [
  { type: 'response.created', response: { id: 'resp_1' } },
  { type: 'response.output_item.added', item: { id: 'msg_1', type: 'message' } },
  { type: 'response.output_text.delta', item_id: 'msg_1', delta: 'Hi' },
  { type: 'response.output_item.done', item: { id: 'msg_1', type: 'message' } },
  { type: 'response.completed', response: { id: 'resp_1', usage: { input_tokens: 5, output_tokens: 1 } } },
];

const bedrockFrame = (event: object): Buffer =>
  encodeFrame({ ':message-type': 'event', ':event-type': 'chunk', ':content-type': 'application/json' }, Buffer.from(JSON.stringify({ bytes: Buffer.from(JSON.stringify(event)).toString('base64') })));

function seenOf(url: string, text: string): Seen {
  const body = JSON.parse(text) as { model?: string; output_config?: { effort?: string }; reasoning?: { effort?: string } };
  const fromUrl = /^\/model\/([^/]+)\//.exec(url)?.[1];
  return { model: fromUrl === undefined ? String(body.model) : decodeURIComponent(fromUrl), effort: body.output_config?.effort ?? null, reasoning: body.reasoning?.effort ?? null };
}

function answer(url: string, seen: Seen, res: ServerResponse): void {
  if (LIMITED.has(seen.model)) {
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '120' }).end('{"type":"error","error":{"type":"rate_limit_error","message":"limit"}}');
    return;
  }
  if (url.startsWith('/model/')) {
    res.writeHead(200, { 'content-type': 'application/vnd.amazon.eventstream' });
    res.write(bedrockFrame({ type: 'message_start', message: { id: 'msg_1' } }));
    res.end(bedrockFrame({ type: 'message_stop' }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  if (url === '/responses') for (const event of codexEvents) res.write(`data: ${JSON.stringify(event)}\n\n`);
  else res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
  res.end();
}

async function listen(server: Server): Promise<string> {
  const port = randomInt(10_000, 30_000);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${String(port)}`;
}

async function upstream(): Promise<Upstream> {
  const held: Upstream = { server: createServer(), base: '', seen: [] };
  held.server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const seen = seenOf(req.url ?? '', Buffer.concat(chunks).toString('utf8'));
      held.seen.push(seen);
      answer(req.url ?? '', seen, res);
    });
  });
  held.base = await listen(held.server);
  return held;
}

const PROVIDERS: Provider[] = ['anthropic', 'bedrock', 'openrouter', 'codex', 'routeway'];
const upstreams = new Map<Provider, Upstream>();
let gateway: Server;
let base = '';
let cfg: ModelSetup;

const connections = [
  makeConnection('anthropic', { apiKey: 'sk-ant-key' }),
  makeConnection('bedrock', { apiKey: 'aws-key', region: 'eu-central-1' }),
  makeConnection('openrouter', { apiKey: 'or-key' }),
  makeConnection('codex', { codex: codexAccess() }),
  makeConnection('routeway', { apiKey: 'rw-key' }),
];

const step = (provider: Provider, model: string): { connection: string; model: string } => ({ connection: connectionId(provider), model });

const setup = (main: { connection: string; model: string }, helpers: Chain | null, effort: ModelSetup['effort'] = {}, fallbacks: ModelSetup['fallbacks'] = []): ModelSetup =>
  ({ primary: main, fallbacks, connections, source: 'organization', helpers, effort });

const seenBy = (provider: Provider): Seen[] => upstreams.get(provider)?.seen ?? [];

const turn = (model: string, effort = 'high'): Record<string, unknown> => ({ model, max_tokens: 8, stream: true, output_config: { effort }, messages: [{ role: 'user', content: 'hi' }] });

const ask = (body: Record<string, unknown>, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(`${base}/gateway/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-metro-key': 'mk_ok', ...headers }, body: JSON.stringify(body) });

async function served(body: Record<string, unknown>, headers: Record<string, string> = {}): Promise<void> {
  const res = await ask(body, headers);
  expect(res.status).toBe(200);
  await res.text();
}

beforeAll(async () => {
  for (const provider of PROVIDERS) upstreams.set(provider, await upstream());
  const at = (provider: Provider): string => upstreams.get(provider)?.base ?? '';
  const deps: GatewayDeps = {
    setup: () => cfg,
    identify: (key) => key === 'mk_ok',
    anthropicBase: at('anthropic'),
    bedrockBase: at('bedrock'),
    openrouterBase: at('openrouter'),
    routewayBase: at('routeway'),
    codex: { base: at('codex'), refresh: () => Promise.resolve(null) },
  };
  gateway = createServer((req, res) => {
    if (!handleGatewayRequest(req, res, deps)) res.writeHead(404).end();
  });
  base = await listen(gateway);
});

afterAll(() => {
  for (const held of upstreams.values()) held.server.close();
  gateway.close();
});

beforeEach(() => {
  resetGatewayState();
  for (const held of upstreams.values()) held.seen.length = 0;
});

describe('helpers on their own models', () => {
  test('without helper models a helper thinks with the main models, as before', async () => {
    cfg = setup(step('openrouter', 'openai/gpt-5.2'), null);
    await served(turn('openrouter:openai/gpt-5.2'), HELPER);
    expect(seenBy('openrouter').map((s) => s.model)).toEqual(['openai/gpt-5.2']);
  });

  test('a helper request goes to the helper model on every provider, whatever model id it names, and the main thread keeps its own', async () => {
    const cases: [Provider, string][] = [['openrouter', 'anthropic/claude-opus-5.5'], ['codex', 'gpt-5.5'], ['routeway', 'deepseek/deepseek-v4'], ['bedrock', 'us.anthropic.claude-opus-5-5'], ['anthropic', 'claude-opus-5-5']];
    for (const [provider, model] of cases) {
      const main = provider === 'openrouter' ? step('codex', 'gpt-5.2') : step('openrouter', 'openai/gpt-5.2');
      cfg = setup(main, { primary: step(provider, model), fallbacks: [] });
      const asked = runnerModel(cfg) ?? '';
      await served(turn(asked), HELPER);
      await served(turn('codex:gpt-5.2'), HELPER);
      await served(turn('claude-sonnet-5-5'), HELPER);
      expect(seenBy(provider).map((s) => s.model)).toEqual([model, model, model]);
      await served(turn(asked));
      const mainSeen = seenBy(main.connection === connectionId('codex') ? 'codex' : 'openrouter');
      expect(mainSeen.at(-1)?.model).toBe(main.model);
      resetGatewayState();
      for (const held of upstreams.values()) held.seen.length = 0;
    }
  });

  test('a haiku chore of a helper stays haiku on a Claude helper model, and becomes the helper model elsewhere', async () => {
    cfg = setup(step('openrouter', 'openai/gpt-5.2'), { primary: step('anthropic', 'claude-opus-5-5'), fallbacks: [] });
    await served(turn('claude-haiku-4-5'), HELPER);
    expect(seenBy('anthropic').map((s) => s.model)).toEqual(['claude-haiku-4-5']);
    cfg = setup(step('anthropic', 'claude-opus-5-5'), { primary: step('routeway', 'qwen/qwen3'), fallbacks: [] });
    await served(turn('claude-haiku-4-5'), HELPER);
    expect(seenBy('routeway').map((s) => s.model)).toEqual(['qwen/qwen3']);
  });

  test('a helper model at its limit hands the request to the next helper backup, and the main thread never sees it', async () => {
    cfg = setup(step('openrouter', 'openai/gpt-5.2'), { primary: step('anthropic', 'busy-model'), fallbacks: [step('routeway', 'deepseek/deepseek-v4')] }, {}, [step('codex', 'gpt-5.2')]);
    await served(turn('openrouter:openai/gpt-5.2'), HELPER);
    expect(seenBy('anthropic').map((s) => s.model)).toEqual(['busy-model']);
    expect(seenBy('routeway').map((s) => s.model)).toEqual(['deepseek/deepseek-v4']);
    expect(holdOf({ connection: connections[0] ?? makeConnection('anthropic'), model: 'busy-model' })?.reason).toBe('answered 429');
    await served(turn('openrouter:openai/gpt-5.2'), HELPER);
    expect(seenBy('anthropic')).toHaveLength(1);
    expect(seenBy('routeway')).toHaveLength(2);
    await served(turn('openrouter:openai/gpt-5.2'));
    expect(seenBy('openrouter').map((s) => s.model)).toEqual(['openai/gpt-5.2']);
    expect(seenBy('codex')).toHaveLength(0);
  });
});

describe('the effort set on the route', () => {
  test('no setting keeps low for the main thread and max for helpers', async () => {
    cfg = setup(step('anthropic', 'claude-opus-5-5'), null);
    await served(turn('claude-opus-5-5'));
    await served(turn('claude-opus-5-5'), HELPER);
    expect(seenBy('anthropic').map((s) => s.effort)).toEqual(['low', 'max']);
  });

  test('each thread gets its own level, and As the agent asks sends what Claude Code asked', async () => {
    cfg = setup(step('anthropic', 'claude-opus-5-5'), null, { main: 'medium', helpers: 'asked' });
    await served(turn('claude-opus-5-5'));
    await served(turn('claude-opus-5-5', 'xhigh'), HELPER);
    cfg = setup(step('anthropic', 'claude-opus-5-5'), null, { main: 'asked', helpers: 'high' });
    await served(turn('claude-opus-5-5', 'medium'));
    await served(turn('claude-opus-5-5', 'xhigh'), HELPER);
    expect(seenBy('anthropic').map((s) => s.effort)).toEqual(['medium', 'xhigh', 'medium', 'high']);
  });

  test('the level follows the helper chain too, with the OpenRouter cap at high', async () => {
    cfg = setup(step('anthropic', 'claude-opus-5-5'), { primary: step('openrouter', 'openai/gpt-5.2'), fallbacks: [] }, { main: 'low', helpers: 'max' });
    await served(turn('claude-opus-5-5'), HELPER);
    expect(seenBy('openrouter')).toEqual([{ model: 'openai/gpt-5.2', effort: 'max', reasoning: 'high' }]);
    expect(seenBy('anthropic')).toHaveLength(0);
  });
});

describe('a compaction', () => {
  const lanes: [Provider, string][] = [['anthropic', 'claude-opus-5-5'], ['bedrock', 'us.anthropic.claude-opus-5-5'], ['openrouter', 'openai/gpt-5.2'], ['codex', 'gpt-6.1-sol'], ['routeway', 'deepseek/deepseek-v4']];

  test("a helper's compaction reaches every provider at low on the helper model, and its ordinary turns still at max", async () => {
    for (const [provider, model] of lanes) {
      const main = provider === 'openrouter' ? step('codex', 'gpt-5.2') : step('openrouter', 'openai/gpt-5.2');
      cfg = setup(main, { primary: step(provider, model), fallbacks: [] }, { main: 'low', helpers: 'max' });
      await served(helperCompaction(), HELPER_HEADERS);
      await served(helperTurn(), HELPER_HEADERS);
      const [compaction, ordinary] = seenBy(provider);
      expect(compaction?.model).toBe(model);
      expect(provider === 'codex' ? compaction?.reasoning : compaction?.effort).toBe('low');
      expect(provider === 'codex' ? ordinary?.reasoning : ordinary?.effort).toBe(provider === 'codex' ? 'xhigh' : 'max');
      if (provider === 'openrouter') expect([compaction?.reasoning, ordinary?.reasoning]).toEqual(['low', 'high']);
      resetGatewayState();
      for (const held of upstreams.values()) held.seen.length = 0;
    }
  });

  test('the main thread compacts at low too, even when the route asks for more or leaves the effort to Claude Code', async () => {
    cfg = setup(step('anthropic', 'claude-opus-5-5'), null, { main: 'max', helpers: 'asked' });
    await served(mainCompaction());
    await served(helperCompaction('claude-opus-5-5'), HELPER_HEADERS);
    expect(seenBy('anthropic').map((s) => s.effort)).toEqual(['low', 'low']);
  });
});
