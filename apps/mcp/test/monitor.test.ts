import { afterEach, describe, expect, test } from 'bun:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { makeEmit, startWebhookServer } from '../src/daemon/http.ts';
import { publishEvent, type MetroEvent } from '../src/daemon/events.ts';
import { setAgentMap } from '../src/db/agent-map.ts';
import { setKeyMap } from '../src/db/key-map.ts';
import type { MonitorCall } from '../src/monitor/api.ts';

const ONE = 'mk_agent_one';
const TWO = 'mk_agent_two';

const AGENTS = {
  'discord-bot/d1': 'agent000001',
  'xmtp/x1': 'agent000001',
  'telegram-bot/t2': 'agent000002',
  'webhook/a1-gh': 'agent000001',
  'webhook/a2-gh': 'agent000002',
};
const NAMES = { ['agent000001']: 'tony', ['agent000002']: 'lisa' };

interface Harness {
  server: Server;
  base: string;
  calls: Array<{ train: string; action: string; args: Record<string, unknown> }>;
}

let active: Harness | undefined;

async function start(
  keys: Array<{ key: string; agentId: number }>,
  call?: MonitorCall,
): Promise<Harness> {
  setKeyMap(keys);
  setAgentMap(AGENTS, NAMES);
  process.env.METRO_WEBHOOK_PORT = String(
    10000 + Math.floor(Math.random() * 20000),
  );
  process.env.METRO_HTTP_HOST = '127.0.0.1';
  const calls: Harness['calls'] = [];
  const monitorCall: MonitorCall =
    call ??
    (async (train, action, args) => {
      calls.push({ train, action, args });
      return { result: { delivered: true, echo: args } };
    });
  const server = await startWebhookServer(makeEmit(), {}, undefined, monitorCall);
  const addr = server.address() as AddressInfo;
  const h: Harness = { server, base: `http://127.0.0.1:${addr.port}`, calls };
  active = h;
  return h;
}

const both = (): Array<{ key: string; agentId: number }> => [
  { key: ONE, agentId: 'agent000001' },
  { key: TWO, agentId: 'agent000002' },
];

afterEach(async () => {
  if (active) {
    const s = active.server;
    await new Promise<void>((r) => s.close(() => r()));
    active = undefined;
  }
  setKeyMap([]);
  setAgentMap({}, {});
});

const post = (
  h: Harness,
  path: string,
  token: string | undefined,
  args: unknown,
): Promise<Response> =>
  fetch(`${h.base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ args }),
  });

describe('monitor transport', () => {
  test('disabled (404) when the daemon holds no credential at all', async () => {
    const h = await start([]);
    const res = await fetch(`${h.base}/api/health`);
    expect(res.status).toBe(404);
  });

  test('/api/call requires a credential', async () => {
    const h = await start(both());
    const res = await post(h, '/api/call/discord-bot/send', undefined, {});
    expect(res.status).toBe(401);
  });

  test('/api/call rejects a token that is not a live agent key', async () => {
    const h = await start(both());
    const res = await post(h, '/api/call/discord-bot/send', 'mk_revoked', {
      line: 'metro://discord-bot/d1/99',
    });
    expect(res.status).toBe(401);
  });

  test('/api/health returns ok/version snapshot', async () => {
    const h = await start(both());
    const res = await fetch(`${h.base}/api/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; version: string };
    expect(body.ok).toBe(true);
    expect(typeof body.version).toBe('string');
  });

  test('/api/call dispatches to a station and returns the result', async () => {
    const h = await start(both());
    const res = await post(h, '/api/call/discord-bot/send', ONE, {
      line: 'metro://discord-bot/d1/99',
      text: 'hi',
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as {
      result: { delivered: boolean; echo: { text: string } };
    };
    expect(j.result.delivered).toBe(true);
    expect(j.result.echo.text).toBe('hi');
    expect(h.calls[0]?.train).toBe('discord-bot');
    expect(h.calls[0]?.action).toBe('send');
  });

  test('an in-core station takes no calls at all', async () => {
    const h = await start(both());
    const res = await post(h, '/api/call/webhook/send', ONE, {
      line: 'metro://webhook/a1-gh',
      text: 'hi',
    });
    expect(res.status).toBe(400);
    const j = (await res.json()) as { error: string };
    expect(j.error).toContain('in-core');
    expect(h.calls).toHaveLength(0);
  });

  test('an agent key cannot drive another agent line', async () => {
    const h = await start(both());
    const res = await post(h, '/api/call/telegram-bot/send', ONE, {
      line: 'metro://telegram-bot/t2/5',
      text: 'not mine',
    });
    expect(res.status).toBe(403);
    expect(h.calls).toHaveLength(0);
  });

  test('an `account` override cannot escape the line scope', async () => {
    const h = await start(both());
    const res = await post(h, '/api/call/discord-bot/send', TWO, {
      line: 'metro://discord-bot/d1/99',
      account: 'd1',
      text: 'not mine',
    });
    expect(res.status).toBe(403);
    expect(h.calls).toHaveLength(0);
  });

  test('a line-less call is allowed only when the station is wholly in scope', async () => {
    const h = await start(both());
    expect((await post(h, '/api/call/xmtp/accounts', ONE, {})).status).toBe(200);
    expect((await post(h, '/api/call/xmtp/accounts', TWO, {})).status).toBe(403);
  });

  test('a line-less call is refused once a second agent shares the station', async () => {
    const h = await start(both());
    setAgentMap({ ...AGENTS, 'discord-bot/d2': 'agent000002' }, NAMES);
    expect((await post(h, '/api/call/discord-bot/accounts', ONE, {})).status).toBe(
      403,
    );
  });

  test('/api/call surfaces a dispatch error as 502', async () => {
    const h = await start(both(), async () => {
      throw new Error('train said no');
    });
    const res = await post(h, '/api/call/discord-bot/send', ONE, {
      line: 'metro://discord-bot/d1/99',
    });
    expect(res.status).toBe(502);
    const j = (await res.json()) as { error: string };
    expect(j.error).toContain('train said no');
  });

  test('/api/call rejects GET with 405', async () => {
    const h = await start(both());
    const res = await fetch(`${h.base}/api/call/discord-bot/send`, {
      headers: { authorization: `Bearer ${ONE}` },
    });
    expect(res.status).toBe(405);
  });
});

const evt = (line: string, text: string): MetroEvent =>
  ({
    id: `msg_${text}`,
    ts: new Date().toISOString(),
    station: line.split('/')[2] ?? '',
    line,
    from: 'metro://discord-bot/peer',
    to: line,
    text,
  }) as MetroEvent;

async function readUntil(
  res: Response,
  needle: string,
): Promise<{ buf: string; cancel: () => Promise<void> }> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (!buf.includes(needle)) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
  }
  return {
    buf,
    cancel: async () => {
      await reader.cancel().catch(() => undefined);
    },
  };
}

describe('monitor tail scoping', () => {
  test('streams a live event published after connect', async () => {
    const h = await start(both());
    const ac = new AbortController();
    const res = await fetch(`${h.base}/api/tail?token=${ONE}`, {
      signal: ac.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    await new Promise((r) => setTimeout(r, 50));
    publishEvent(evt('metro://discord-bot/d1/99', 'live hello'));
    const { buf, cancel } = await readUntil(res, 'live hello');
    expect(buf).toContain('event: live');
    await cancel();
    ac.abort();
  });

  test('another agent line never reaches the tail, a local one does', async () => {
    const h = await start(both());
    const ac = new AbortController();
    const res = await fetch(`${h.base}/api/tail?token=${ONE}`, {
      signal: ac.signal,
    });
    await new Promise((r) => setTimeout(r, 50));
    publishEvent(evt('metro://telegram-bot/t2/5', 'other agent secret'));
    publishEvent(evt('metro://claude/org/session', 'local event'));
    publishEvent(evt('metro://discord-bot/d1/99', 'mine at last'));
    const { buf, cancel } = await readUntil(res, 'mine at last');
    expect(buf).not.toContain('other agent secret');
    expect(buf).toContain('local event');
    await cancel();
    ac.abort();
  });

  test('another agent webhook never reaches the tail', async () => {
    const h = await start(both());
    const ac = new AbortController();
    const res = await fetch(`${h.base}/api/tail?token=${ONE}`, {
      signal: ac.signal,
    });
    await new Promise((r) => setTimeout(r, 50));
    publishEvent(evt('metro://webhook/a2-gh', 'other agent webhook body'));
    publishEvent(evt('metro://discord-bot/d1/99', 'mine at last'));
    const { buf, cancel } = await readUntil(res, 'mine at last');
    expect(buf).not.toContain('other agent webhook body');
    await cancel();
    ac.abort();
  });

  test('the same tail for the second agent sees only its own line', async () => {
    const h = await start(both());
    const ac = new AbortController();
    const res = await fetch(`${h.base}/api/tail?token=${TWO}`, {
      signal: ac.signal,
    });
    await new Promise((r) => setTimeout(r, 50));
    publishEvent(evt('metro://discord-bot/d1/99', 'agent one traffic'));
    publishEvent(evt('metro://telegram-bot/t2/5', 'agent two traffic'));
    const { buf, cancel } = await readUntil(res, 'agent two traffic');
    expect(buf).not.toContain('agent one traffic');
    await cancel();
    ac.abort();
  });
});
