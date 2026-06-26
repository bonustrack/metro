import { afterEach, describe, expect, test } from 'bun:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { makeEmit, startWebhookServer } from '../src/daemon/http.ts';
import { publishEvent, type MetroEvent } from '../src/daemon/events.ts';
import type { MonitorCall } from '../src/monitor/api.ts';

const TOKEN = 'monitor-test-token';

interface Harness {
  server: Server;
  base: string;
  calls: Array<{ train: string; action: string; args: Record<string, unknown> }>;
}

let active: Harness | undefined;

async function start(
  env: Record<string, string | undefined>,
  call?: MonitorCall,
): Promise<Harness> {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  process.env.METRO_WEBHOOK_PORT = String(
    20000 + Math.floor(Math.random() * 20000),
  );
  process.env.METRO_HTTP_HOST = '127.0.0.1';
  const calls: Harness['calls'] = [];
  const monitorCall: MonitorCall =
    call ??
    (async (train, action, args) => {
      calls.push({ train, action, args });
      return { result: { delivered: true, echo: args } };
    });
  const server = await startWebhookServer(makeEmit(), undefined, monitorCall);
  const addr = server.address() as AddressInfo;
  const h: Harness = { server, base: `http://127.0.0.1:${addr.port}`, calls };
  active = h;
  return h;
}

afterEach(async () => {
  if (active) {
    const s = active.server;
    await new Promise<void>((r) => s.close(() => r()));
    active = undefined;
  }
  delete process.env.METRO_MCP_HTTP_TOKEN;
});

describe('monitor transport', () => {
  test('disabled (404) when METRO_MCP_HTTP_TOKEN unset', async () => {
    const h = await start({ METRO_MCP_HTTP_TOKEN: undefined });
    const res = await fetch(`${h.base}/api/health`);
    expect(res.status).toBe(404);
  });

  test('/api/call requires a bearer token', async () => {
    const h = await start({ METRO_MCP_HTTP_TOKEN: TOKEN });
    const res = await fetch(`${h.base}/api/call/discord/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ args: {} }),
    });
    expect(res.status).toBe(401);
  });

  test('/api/health returns ok/version snapshot', async () => {
    const h = await start({ METRO_MCP_HTTP_TOKEN: TOKEN });
    const res = await fetch(`${h.base}/api/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; version: string };
    expect(body.ok).toBe(true);
    expect(typeof body.version).toBe('string');
  });

  test('/api/call dispatches to a station and returns the result', async () => {
    const h = await start({ METRO_MCP_HTTP_TOKEN: TOKEN });
    const res = await fetch(`${h.base}/api/call/discord/send`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ args: { line: 'metro://discord/1', text: 'hi' } }),
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as {
      result: { delivered: boolean; echo: { text: string } };
    };
    expect(j.result.delivered).toBe(true);
    expect(j.result.echo.text).toBe('hi');
    expect(h.calls[0]?.train).toBe('discord');
    expect(h.calls[0]?.action).toBe('send');
  });

  test('/api/call surfaces a dispatch error as 502', async () => {
    const h = await start({ METRO_MCP_HTTP_TOKEN: TOKEN }, async () => {
      throw new Error('train said no');
    });
    const res = await fetch(`${h.base}/api/call/discord/send`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ args: {} }),
    });
    expect(res.status).toBe(502);
    const j = (await res.json()) as { error: string };
    expect(j.error).toContain('train said no');
  });

  test('/api/call rejects GET with 405', async () => {
    const h = await start({ METRO_MCP_HTTP_TOKEN: TOKEN });
    const res = await fetch(`${h.base}/api/call/discord/send`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(405);
  });

  test('/api/tail streams a live event published after connect', async () => {
    const h = await start({ METRO_MCP_HTTP_TOKEN: TOKEN });
    const ac = new AbortController();
    const res = await fetch(`${h.base}/api/tail?token=${TOKEN}`, {
      signal: ac.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    const evt: MetroEvent = {
      id: 'msg_test',
      ts: new Date().toISOString(),
      station: 'discord',
      line: 'metro://discord/1' as MetroEvent['line'],
      from: 'metro://discord/peer' as MetroEvent['from'],
      to: 'metro://discord/1' as MetroEvent['to'],
      text: 'live hello',
    };
    await new Promise((r) => setTimeout(r, 50));
    publishEvent(evt);

    let buf = '';
    while (!buf.includes('live hello')) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
    }
    expect(buf).toContain('event: live');
    expect(buf).toContain('live hello');
    await reader.cancel().catch(() => undefined);
    ac.abort();
  });
});
