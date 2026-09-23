import { afterEach, describe, expect, test } from 'bun:test';
import { bootDaemon, type Daemon } from './http-harness.ts';
import { publishEvent, type MetroEvent } from '@metro-labs/core/events';
import { setAgentMap } from '../src/agents/map.ts';
import { setKeyMap } from '../src/agents/keys.ts';

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

let active: Daemon | undefined;

async function start(
  keys: Array<{ key: string; agentId: number }>,
): Promise<Daemon> {
  setKeyMap(keys);
  setAgentMap(AGENTS, NAMES);
  active = await bootDaemon({}, { monitor: true });
  return active;
}

const both = (): Array<{ key: string; agentId: number }> => [
  { key: ONE, agentId: 'agent000001' },
  { key: TWO, agentId: 'agent000002' },
];

afterEach(async () => {
  await active?.close();
  active = undefined;
  setKeyMap([]);
  setAgentMap({}, {});
});

describe('monitor transport', () => {
  test('disabled (404) when the daemon holds no credential at all', async () => {
    const h = await start([]);
    expect((await fetch(`${h.base}/api/tail`)).status).toBe(404);
  });

  test('the tail needs a live agent key', async () => {
    const h = await start(both());
    expect((await fetch(`${h.base}/api/tail`)).status).toBe(401);
    const res = await fetch(`${h.base}/api/tail`, { headers: { authorization: 'Bearer mk_revoked' } });
    expect(res.status).toBe(401);
  });

  test('there is no call route and no second health route: a train is reached through MCP only', async () => {
    const h = await start(both());
    const headers = { authorization: `Bearer ${ONE}`, 'content-type': 'application/json' };
    const call = await fetch(`${h.base}/api/call/xmtp/claim_name`, { method: 'POST', headers, body: '{}' });
    expect(call.status).toBe(404);
    expect((await fetch(`${h.base}/api/health`, { headers })).status).toBe(404);
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
