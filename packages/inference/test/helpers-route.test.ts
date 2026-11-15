import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomInt } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { encodeFrame } from '@metro-labs/inference/eventstream';
import { handleGatewayRequest, resetGatewayState, type GatewayDeps } from '@metro-labs/inference/gateway';
import { holdOf } from '@metro-labs/inference/fallback';
import { runnerModel, type Chain, type ModelSetup, type Provider } from '@metro-labs/inference/model-config';
import { codexAccess, connectionId, makeConnection } from './model-fixture.ts';
import { COMPACTION_HINTS, HELPER_HEADERS, helperCompaction, helperTurn, mainCompaction } from './compaction-fixture.ts';

interface Seen {
  model: string;
  effort: string | null;
  reasoning: string | null;
}

interface Upstream {
  server: Server;
  base: string;
  seen: Seen[];
  bodies: string[];
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
  const held: Upstream = { server: createServer(), base: '', seen: [], bodies: [] };
  held.server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const seen = seenOf(req.url ?? '', text);
      held.seen.push(seen);
      held.bodies.push(text);
      answer(req.url ?? '', seen, res);
    });
  });
  held.base = await listen(held.server);
  return held;
}

const PROVIDERS: Provider[] = ['anthropic', 'bedrock', 'openrouter', 'codex', 'routeway'];
const upstreams = new Map<Provider, Upstream>();
let gateway: Server;
let named: Server;
let base = '';
let namedBase = '';
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

const ask = (body: Record<string, unknown>, headers: Record<string, string> = {}, at = base): Promise<Response> =>
  fetch(`${at}/gateway/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-metro-key': 'mk_ok', ...headers }, body: JSON.stringify(body) });

async function served(body: Record<string, unknown>, headers: Record<string, string> = {}, at = base): Promise<void> {
  const res = await ask(body, headers, at);
  expect(res.status).toBe(200);
  await res.text();
}

const clearSeen = (): void => {
  for (const held of upstreams.values()) {
    held.seen.length = 0;
    held.bodies.length = 0;
  }
};

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
  const namedDeps: GatewayDeps = { ...deps, named: true };
  named = createServer((req, res) => {
    if (!handleGatewayRequest(req, res, namedDeps)) res.writeHead(404).end();
  });
  namedBase = await listen(named);
});

afterAll(() => {
  for (const held of upstreams.values()) held.server.close();
  gateway.close();
  named.close();
});

beforeEach(() => {
  resetGatewayState();
  clearSeen();
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

describe('a Codex request that asks no effort', () => {
  const CODEX = step('codex', 'gpt-6.1-sol');
  const unasked = (model: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ model, max_tokens: 8, stream: true, messages: [{ role: 'user', content: 'hi' }], ...extra });
  const reasoning = (): (string | null)[] => seenBy('codex').map((s) => s.reasoning);
  const withoutEffort = (body: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'output_config'));

  test("a box's main thread and its workers get the route's level for their thread, not medium", async () => {
    cfg = setup(CODEX, null);
    await served(unasked(runnerModel(cfg) ?? ''));
    await served(unasked(runnerModel(cfg) ?? ''), HELPER);
    cfg = setup(CODEX, null, { main: 'high', helpers: 'medium' });
    await served(unasked(runnerModel(cfg) ?? ''));
    await served(unasked(runnerModel(cfg) ?? ''), HELPER);
    expect(reasoning()).toEqual(['low', 'xhigh', 'high', 'medium']);
  });

  test('an access key gets the main level on metro and the worker level on metro-workers, with or without worker models', async () => {
    cfg = setup(CODEX, { primary: step('codex', 'gpt-6.2'), fallbacks: [] });
    await served(unasked('metro'), {}, namedBase);
    await served(unasked('metro-workers'), {}, namedBase);
    cfg = setup(CODEX, null, { main: 'medium', helpers: 'high' });
    await served(unasked('metro'), {}, namedBase);
    await served(unasked('metro-workers'), {}, namedBase);
    expect(seenBy('codex')).toEqual([
      { model: 'gpt-6.1-sol', effort: null, reasoning: 'low' },
      { model: 'gpt-6.2', effort: null, reasoning: 'xhigh' },
      { model: 'gpt-6.1-sol', effort: null, reasoning: 'medium' },
      { model: 'gpt-6.1-sol', effort: null, reasoning: 'high' },
    ]);
  });

  test('As the agent asks keeps medium on every thread, and so does a chore', async () => {
    cfg = setup(CODEX, null, { main: 'asked', helpers: 'asked' });
    await served(unasked(runnerModel(cfg) ?? ''));
    await served(unasked(runnerModel(cfg) ?? ''), HELPER);
    await served(unasked('metro'), {}, namedBase);
    await served(unasked('metro-workers'), {}, namedBase);
    cfg = setup(CODEX, null, { main: 'max', helpers: 'max' });
    await served(unasked(runnerModel(cfg) ?? '', { output_config: { format: { type: 'json_schema', schema: {} } } }));
    expect(reasoning()).toEqual(['medium', 'medium', 'medium', 'medium', 'medium']);
  });

  test('a request that asks an effort, a thinking budget or no thinking is answered as before', async () => {
    cfg = setup(CODEX, null, { main: 'max', helpers: 'low' });
    const model = runnerModel(cfg) ?? '';
    await served(unasked(model, { output_config: { effort: 'medium' } }));
    await served(unasked(model, { output_config: { effort: 'high' } }), HELPER);
    await served(unasked(model, { thinking: { type: 'enabled', budget_tokens: 2_000 } }));
    await served(unasked(model, { thinking: { type: 'enabled', budget_tokens: 8_000 } }));
    await served(unasked(model, { thinking: { type: 'enabled', budget_tokens: 32_000 } }), HELPER);
    await served(unasked(model, { thinking: { type: 'disabled' } }));
    await served(unasked(model, { messages: [{ role: 'user', content: 'hi' }, { role: 'system', output_config: { effort: 'high' }, content: 'context' }] }));
    expect(reasoning()).toEqual(['xhigh', 'low', 'low', 'medium', 'high', 'low', 'medium']);
  });

  test('a compaction that asks no effort runs at low, even when the route asks for more', async () => {
    cfg = setup(CODEX, null, { main: 'max', helpers: 'max' });
    const model = runnerModel(cfg) ?? '';
    await served(withoutEffort(mainCompaction(model)));
    await served(withoutEffort(helperCompaction(model)), HELPER_HEADERS);
    await served(unasked(model), COMPACTION_HINTS);
    expect(reasoning()).toEqual(['low', 'low', 'low']);
  });

  test('every other route gets an unasked request exactly as before: nothing added, the same bytes whatever the route sets', async () => {
    const others: [Provider, string][] = [['anthropic', 'claude-opus-5-5'], ['bedrock', 'us.anthropic.claude-opus-5-5'], ['openrouter', 'openai/gpt-5.2'], ['routeway', 'deepseek/deepseek-v4']];
    const settings: ModelSetup['effort'][] = [{}, { main: 'max', helpers: 'low' }, { main: 'asked', helpers: 'asked' }];
    for (const [provider, model] of others) {
      const sent: string[][] = [];
      for (const effort of settings) {
        cfg = setup(step(provider, model), null, effort);
        const body = unasked(runnerModel(cfg) ?? '');
        await served(body);
        await served(body, HELPER);
        await served(unasked('metro'), {}, namedBase);
        await served(unasked('metro-workers'), {}, namedBase);
        const bodies = upstreams.get(provider)?.bodies ?? [];
        sent.push([...bodies]);
        if (provider === 'anthropic') expect(bodies.slice(0, 2)).toEqual([JSON.stringify(body), JSON.stringify(body)]);
        for (const text of bodies) expect(Object.keys(JSON.parse(text) as Record<string, unknown>)).not.toContain('output_config');
        if (provider !== 'openrouter') for (const text of bodies) expect(Object.keys(JSON.parse(text) as Record<string, unknown>)).not.toContain('reasoning');
        clearSeen();
      }
      expect(sent[0]).toHaveLength(4);
      expect(sent[1]).toEqual(sent[0]);
      expect(sent[2]).toEqual(sent[0]);
      expect(seenBy('codex')).toHaveLength(0);
    }
  });
});
