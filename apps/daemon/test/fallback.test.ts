import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { handleGatewayRequest, resetGatewayState, type GatewayDeps } from '../src/gateway/gateway.ts';
import { chainOf, chainStatus, holdOf, routesToTry } from '../src/gateway/fallback.ts';
import { noteUsage } from '../src/gateway/usage.ts';
import { lastServed } from '../src/gateway/served.ts';
import { ModelConfigError, parseModelConfig, removeConnection, setFallbacks, type ModelConfig, type Route } from '../src/gateway/model-config.ts';
import { conn, configOf, connectionId, makeConnection } from './model-fixture.ts';

const NOW = Date.parse('2026-10-03T23:00:00.000Z');
const LATER = '2026-10-08T07:00:00.000Z';
const EARLIER = '2026-10-03T22:00:00.000Z';

const setup = (): ModelConfig => ({
  ...configOf('anthropic', [
    makeConnection('anthropic'),
    makeConnection('openrouter', { apiKey: 'or-key', model: 'openai/gpt-6' }),
    makeConnection('codex', { model: 'gpt-6-luna' }),
  ]),
  fallbacks: [
    { connection: connectionId('anthropic'), model: 'claude-fable-5-1' },
    { connection: connectionId('openrouter'), model: 'anthropic/claude-opus-5-5' },
  ],
});

const opus = (cfg: ModelConfig): Route => ({ connection: conn(cfg, 'anthropic'), model: 'claude-opus-5-5' });

const window = (label: string, used: number, resetAt: string | null = LATER): { label: string; used: number; resetAt: string | null; detail: null } => ({ label, used, resetAt, detail: null });

const login = (...windows: ReturnType<typeof window>[]): void => {
  noteUsage(connectionId('anthropic'), { windows, note: null, at: new Date(NOW).toISOString() });
};

const models = (routes: Route[]): string[] => routes.map((r) => `${r.connection.provider}:${r.model}`);

beforeEach(() => {
  resetGatewayState();
});

describe('the order of the models', () => {
  test('the first model comes first, then each fallback in the order the owner set', () => {
    const cfg = setup();
    expect(models(chainOf(opus(cfg), cfg, 'claude-opus-5-5'))).toEqual(['anthropic:claude-opus-5-5', 'anthropic:claude-fable-5-1', 'openrouter:anthropic/claude-opus-5-5']);
    cfg.fallbacks = [...(cfg.fallbacks ?? [])].reverse();
    expect(models(chainOf(opus(cfg), cfg, 'claude-opus-5-5'))).toEqual(['anthropic:claude-opus-5-5', 'openrouter:anthropic/claude-opus-5-5', 'anthropic:claude-fable-5-1']);
  });

  test('a fallback that is not set up, or the same as the first model, is left out; a haiku chore stays haiku on a Claude fallback', () => {
    const cfg = setup();
    cfg.fallbacks = [
      { connection: connectionId('codex'), model: 'gpt-6-luna' },
      { connection: connectionId('anthropic'), model: 'claude-opus-5-5' },
      { connection: connectionId('anthropic'), model: 'claude-fable-5-1' },
    ];
    expect(models(chainOf(opus(cfg), cfg, 'claude-opus-5-5'))).toEqual(['anthropic:claude-opus-5-5', 'anthropic:claude-fable-5-1']);
    const haiku: Route = { connection: conn(cfg, 'anthropic'), model: 'claude-haiku-4-5' };
    expect(models(chainOf(haiku, cfg, 'claude-haiku-4-5'))).toEqual(['anthropic:claude-haiku-4-5']);
  });

  test('the list is kept in model.json, unknown connections and repeats dropped, and removing a connection removes its fallbacks', () => {
    const cfg = setup();
    const raw = { ...cfg, fallbacks: [...(cfg.fallbacks ?? []), { connection: 'gone', model: 'x' }, { connection: connectionId('anthropic'), model: 'claude-fable-5-1' }] };
    expect(parseModelConfig(JSON.parse(JSON.stringify(raw))).fallbacks).toEqual(cfg.fallbacks);
    expect(removeConnection(cfg, connectionId('openrouter')).fallbacks).toEqual([{ connection: connectionId('anthropic'), model: 'claude-fable-5-1' }]);
    expect(setFallbacks(cfg, []).fallbacks).toBeUndefined();
    expect(() => setFallbacks(cfg, [{ connection: 'gone', model: 'x' }])).toThrow(ModelConfigError);
    expect(() => setFallbacks(cfg, [{ connection: connectionId('codex'), model: '' }])).toThrow('each fallback needs a model');
    expect(() => setFallbacks(cfg, 'nope')).toThrow('fallbacks must be a list');
  });
});

describe('a model over 95% of its usage is skipped', () => {
  test('a window above 95% skips the model, 95% itself does not', () => {
    const cfg = setup();
    const chain = chainOf(opus(cfg), cfg, 'claude-opus-5-5');
    login(window('5-hour window', 0.95), window('Weekly', 0.4));
    expect(models(routesToTry(chain, NOW))[0]).toBe('anthropic:claude-opus-5-5');
    login(window('5-hour window', 0.96), window('Weekly', 0.4));
    expect(models(routesToTry(chain, NOW))).toEqual(['openrouter:anthropic/claude-opus-5-5']);
    expect(holdOf(opus(cfg), NOW)).toEqual({ reason: '5-hour window 96%', until: LATER });
  });

  test('a weekly window of one model skips only that model on the same login', () => {
    const cfg = setup();
    login(window('5-hour window', 0.38), window('Weekly', 0.64), window('Weekly, Fable', 1));
    expect(models(routesToTry(chainOf(opus(cfg), cfg, 'claude-opus-5-5'), NOW))).toEqual(['anthropic:claude-opus-5-5', 'openrouter:anthropic/claude-opus-5-5']);
    login(window('Weekly, Opus', 0.99));
    expect(models(routesToTry(chainOf(opus(cfg), cfg, 'claude-opus-5-5'), NOW))).toEqual(['anthropic:claude-fable-5-1', 'openrouter:anthropic/claude-opus-5-5']);
  });

  test('a per-minute token window never skips a model, and when every model is over, the first one is tried', () => {
    const cfg = setup();
    const keyed: Route = { connection: conn(cfg, 'openrouter'), model: 'openai/gpt-6' };
    noteUsage(connectionId('openrouter'), { windows: [window('Tokens per minute', 1)], note: null, at: new Date(NOW).toISOString() });
    expect(holdOf(keyed, NOW)).toBeNull();
    noteUsage(connectionId('openrouter'), { windows: [window('Credits', 0.99, null)], note: null, at: new Date(NOW).toISOString() });
    login(window('Weekly', 1));
    expect(models(routesToTry(chainOf(opus(cfg), cfg, 'claude-opus-5-5'), NOW))).toEqual(['anthropic:claude-opus-5-5']);
  });

  test('the page sees each model of the list with its usage, what holds it, and which one is active', () => {
    const cfg = setup();
    cfg.connections[0] = { ...conn(cfg, 'anthropic'), model: 'claude-opus-5-5' };
    login(window('Weekly', 0.97), window('Weekly, Fable', 0.2));
    const rows = chainStatus(cfg, NOW);
    expect(rows.map((r) => [r.model, r.used, r.hold?.reason ?? null, r.active])).toEqual([
      ['claude-opus-5-5', 0.97, 'Weekly 97%', false],
      ['claude-fable-5-1', 0.97, 'Weekly 97%', false],
      ['anthropic/claude-opus-5-5', null, null, true],
    ]);
  });
});

describe('back to the first model once its window resets', () => {
  test('a window whose reset time has passed no longer counts', () => {
    const cfg = setup();
    const chain = chainOf(opus(cfg), cfg, 'claude-opus-5-5');
    login(window('5-hour window', 1, EARLIER));
    expect(models(routesToTry(chain, NOW))[0]).toBe('anthropic:claude-opus-5-5');
    login(window('5-hour window', 1, LATER));
    expect(models(routesToTry(chain, NOW))[0]).toBe('openrouter:anthropic/claude-opus-5-5');
    expect(models(routesToTry(chain, Date.parse(LATER) + 1))[0]).toBe('anthropic:claude-opus-5-5');
  });
});

interface Fake {
  server: Server;
  base: string;
  models: string[];
  answer: (model: string, res: ServerResponse) => void;
}

async function fake(answer: Fake['answer']): Promise<Fake> {
  const box: Fake = { server: createServer(), base: '', models: [], answer };
  box.server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"data":[]}');
        return;
      }
      const model = String((JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model?: unknown }).model);
      box.models.push(model);
      box.answer(model, res);
    });
  });
  await new Promise<void>((r) => {
    box.server.listen(0, '127.0.0.1', r);
  });
  box.base = `http://127.0.0.1:${String((box.server.address() as AddressInfo).port)}`;
  return box;
}

const stream = (res: ServerResponse, from: string): void => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(`event: message_start\ndata: {"type":"message_start","from":"${from}"}\n\n`);
};

const limited = (res: ServerResponse): void => {
  res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '120', 'anthropic-ratelimit-unified-status': 'rejected' });
  res.end('{"type":"error","error":{"type":"rate_limit_error","message":"weekly limit reached"}}');
};

let anthropic: Fake;
let openrouter: Fake;
let gateway: Server;
let base = '';
let cfg: ModelConfig;
let openrouterDown = false;

beforeAll(async () => {
  anthropic = await fake((model, res) => {
    if (model === 'claude-opus-5-5') limited(res);
    else stream(res, 'anthropic');
  });
  openrouter = await fake((_model, res) => {
    if (openrouterDown) limited(res);
    else stream(res, 'openrouter');
  });
  const deps: GatewayDeps = { config: () => cfg, identify: (key) => key === 'mk_ok', anthropicBase: anthropic.base, openrouterBase: openrouter.base };
  gateway = createServer((req, res) => {
    if (!handleGatewayRequest(req, res, deps)) res.writeHead(404).end();
  });
  await new Promise<void>((r) => {
    gateway.listen(0, '127.0.0.1', r);
  });
  base = `http://127.0.0.1:${String((gateway.address() as AddressInfo).port)}`;
});

afterAll(() => {
  for (const s of [anthropic.server, openrouter.server, gateway]) s.close();
});

const ask = (model: string): Promise<Response> =>
  fetch(`${base}/gateway/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-metro-key': 'mk_ok', authorization: 'Bearer sk-ant-oat-login' },
    body: JSON.stringify({ model, max_tokens: 8, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  });

describe('a real limit answer moves the request to the next model', () => {
  beforeEach(() => {
    cfg = { ...setup(), fallbacks: [{ connection: connectionId('openrouter'), model: 'anthropic/claude-opus-5-5' }] };
    anthropic.models.length = 0;
    openrouter.models.length = 0;
    openrouterDown = false;
  });

  test('a 429 from the first model is never shown: the same request is answered by the fallback, and the first model rests until its retry time', async () => {
    const first = await ask('claude-opus-5-5');
    expect(first.status).toBe(200);
    expect(await first.text()).toContain('"from":"openrouter"');
    expect(anthropic.models).toEqual(['claude-opus-5-5']);
    expect(openrouter.models).toEqual(['anthropic/claude-opus-5-5']);
    expect(lastServed()?.provider).toBe('openrouter');

    const second = await ask('claude-opus-5-5');
    expect(await second.text()).toContain('"from":"openrouter"');
    expect(anthropic.models).toEqual(['claude-opus-5-5']);
    expect(holdOf(opus(cfg))?.reason).toBe('answered 429');
  });

  test('when the last model also answers 429, Claude Code gets that answer as it was', async () => {
    openrouterDown = true;
    const res = await ask('claude-opus-5-5');
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('120');
    expect(await res.text()).toContain('rate_limit_error');
    expect(anthropic.models).toEqual(['claude-opus-5-5']);
    expect(openrouter.models).toEqual(['anthropic/claude-opus-5-5']);
  });

  test('a model that answers is used as it is, and nothing else is asked', async () => {
    const res = await ask('claude-fable-5-1');
    expect(await res.text()).toContain('"from":"anthropic"');
    expect(anthropic.models).toEqual(['claude-fable-5-1']);
    expect(openrouter.models).toEqual([]);
  });
});
