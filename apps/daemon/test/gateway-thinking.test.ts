import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { handleGatewayRequest, resetGatewayState } from '../src/gateway/gateway.ts';
import type { ModelSetup } from '../src/gateway/model-config.ts';
import { connectionId, makeConnection, setupOf } from './model-fixture.ts';
import { THINKING_OFF_REFUSAL } from './claude-models-fixture.ts';

const CLAUDE_TOKEN = `sk-ant-oat01-${'e'.repeat(80)}`;

interface Seen {
  method: string;
  body: Record<string, unknown>;
}

const seen: Seen[] = [];
let anthropic: Server;
let gateway: Server;
let anthropicBase = '';
let base = '';
let cfg: ModelSetup;

const listen = async (server: Server): Promise<string> => {
  await new Promise<void>((r) => {
    server.listen(0, '127.0.0.1', r);
  });
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
};

beforeAll(async () => {
  anthropic = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const body = text === '' ? {} : (JSON.parse(text) as Record<string, unknown>);
      seen.push({ method: req.method ?? '', body });
      const thinking = body.thinking as { type?: unknown } | undefined;
      if (body.model === 'claude-sonnet-5-5' && body.temperature !== undefined) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end('{"type":"error","error":{"type":"invalid_request_error","message":"temperature is not supported"}}');
        return;
      }
      if (body.model === 'claude-sonnet-5-5' && thinking?.type === 'disabled') {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(THINKING_OFF_REFUSAL);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg_1', type: 'message', model: body.model }));
    });
  });
  anthropicBase = await listen(anthropic);
  gateway = createServer((req, res) => {
    if (handleGatewayRequest(req, res, { setup: () => cfg, identify: (key) => key === 'mk_ok', anthropicBase })) return;
    res.writeHead(404).end();
  });
  base = await listen(gateway);
});

afterAll(() => {
  anthropic.close();
  gateway.close();
});

beforeEach(() => {
  resetGatewayState();
  seen.length = 0;
  cfg = { ...setupOf('anthropic', [makeConnection('anthropic', { claudeToken: CLAUDE_TOKEN })]), primary: { connection: connectionId('anthropic'), model: 'claude-sonnet-5-5' } };
});

const post = (body: Record<string, unknown>): Promise<Response> =>
  fetch(`${base}/gateway/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-metro-key': 'mk_ok' },
    body: JSON.stringify(body),
  });

const turn = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ model: 'claude-opus-5-5', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }], ...extra });

describe('a model that cannot run with thinking off', () => {
  test('is learned from its refusal, and the request goes again without that setting', async () => {
    const chore = turn({ thinking: { type: 'disabled' } });
    const res = await post(chore);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ model: 'claude-sonnet-5-5' });
    const sent = seen.filter((s) => s.method === 'POST');
    expect(sent.map((s) => s.body.model)).toEqual(['claude-sonnet-5-5', 'claude-sonnet-5-5', 'claude-sonnet-5-5']);
    expect(sent.at(-1)?.body).not.toHaveProperty('thinking');
    seen.length = 0;
    expect((await post(chore)).status).toBe(200);
    expect(seen.length).toBe(1);
    expect(seen[0]?.body).not.toHaveProperty('thinking');
  });

  test('two requests racing on a model not learned yet both get through', async () => {
    const chore = turn({ thinking: { type: 'disabled' } });
    const answers = await Promise.all([post(chore), post(chore), post(chore)]);
    expect(answers.map((r) => r.status)).toEqual([200, 200, 200]);
  });

  test('any other refusal reaches Claude Code as it came, and teaches nothing', async () => {
    const res = await post(turn({ thinking: { type: 'disabled' }, temperature: 1 }));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('temperature is not supported');
    seen.length = 0;
    await post(turn({ thinking: { type: 'disabled' } }));
    expect(seen.length).toBe(3);
  });
});
