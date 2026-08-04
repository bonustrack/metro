import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { makeEmit, startWebhookServer } from '../src/daemon/http.ts';
import { attachmentUrl } from '../src/daemon/attach-serve.ts';
import { signSession } from '../src/daemon/session.ts';
import { publishEvent, type MetroEvent } from '../src/daemon/events.ts';
import { asLine } from '../src/stations/lines.ts';
import { closeAgentSession, createMetroMcp } from '../src/mcp/index.ts';
import { agentIdForKey, rotateAgentKey, setKeyMap } from '../src/db/key-map.ts';
import { setAgentMap } from '../src/db/agent-map.ts';
import { AgentAdminError } from '../src/db/agent-admin.ts';
import type { AgentApiDeps } from '../src/daemon/agent-api.ts';

const SECRET = 'key-reset-test-secret';
const ADA = 1;
const BOB = 2;
const ADA_ACCOUNT = 'a1-adawa';
const BOB_ACCOUNT = 'a2-bobwa';
const ADA_LINE = `metro://whatsapp/${ADA_ACCOUNT}/111@lid`;
const BOB_LINE = `metro://whatsapp/${BOB_ACCOUNT}/222@lid`;
const ADA_FILE = 'msg_adaattach_0.png';
const BOB_FILE = 'msg_bobattach_0.png';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const OWNERS: Record<number, string> = {
  [ADA]: 'ada@lovelace.dev',
  [BOB]: 'bob@builder.dev',
};

let keys: Record<number, string> = {};
let server: Server | undefined;
let base = '';
let attachDir = '';
let adaUrl = '';
let bobUrl = '';
let priorStations: string | undefined;

const mint = (agentId: number): string =>
  `mk_reset_${agentId}_${randomUUID().replace(/-/g, '')}`;

async function resetKey(
  email: string,
  _granted: string[],
  id: number,
): Promise<{ id: number; name: string; key: string }> {
  if (OWNERS[id] !== email) throw new AgentAdminError('no such agent', 404);
  const key = mint(id);
  keys[id] = key;
  rotateAgentKey(id, key);
  await closeAgentSession(id);
  return { id, name: `agent-${id}`, key };
}

const deps: AgentApiDeps = {
  listAgents: () => Promise.resolve([]),
  createAgent: () => Promise.reject(new AgentAdminError('not here', 400)),
  deleteAgent: () => Promise.reject(new AgentAdminError('not here', 400)),
  resetKey,
  gatherAccounts: () => Promise.resolve({}),
  capabilities: () => ({}),
  attachSessions: {
    start: () => Promise.reject(new AgentAdminError('not here', 400)),
    view: () => {
      throw new AgentAdminError('not here', 400);
    },
    submit: () => Promise.reject(new AgentAdminError('not here', 400)),
    cancel: () => Promise.reject(new AgentAdminError('not here', 400)),
  },
  prepareAccount: () => Promise.reject(new AgentAdminError('not here', 400)),
  attachAccount: () => Promise.reject(new AgentAdminError('not here', 400)),
  detachAccount: () => Promise.reject(new AgentAdminError('not here', 400)),
  syncStations: () => Promise.resolve(),
};

const session = (email: string): string =>
  signSession({ email, agentIds: [] }, SECRET);

const msg = (line: string, text: string): MetroEvent =>
  ({
    id: `id-${randomUUID()}`,
    ts: new Date().toISOString(),
    station: 'whatsapp',
    line: asLine(line),
    from: asLine(`${line}/sender`),
    to: asLine(line),
    text,
    messageId: `m-${randomUUID()}`,
    event: { type: 'msg' },
  }) as unknown as MetroEvent;

const status = async (
  url: string,
  headers?: Record<string, string>,
): Promise<number> => {
  const res = await fetch(url, {
    headers: { connection: 'close', ...headers },
  });
  await res.body?.cancel();
  return res.status;
};

interface Probe {
  status: number;
  sessionId: string | null;
}

const mcpProbe = async (token: string): Promise<Probe> => {
  const res = await fetch(`${base}/mcp?token=${token}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      connection: 'close',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'probe', version: '0.0.0' },
      },
    }),
  });
  const sessionId = res.headers.get('mcp-session-id');
  await res.body?.cancel();
  return { status: res.status, sessionId };
};

const initSession = async (token: string): Promise<string> => {
  const probe = await mcpProbe(token);
  if (!probe.sessionId)
    throw new Error(`no session id (status ${probe.status})`);
  return probe.sessionId;
};

interface Stream {
  raw: () => string;
  status: number;
  ended: () => boolean;
  stop: () => Promise<void>;
}

const openGet = async (token: string, sessionId: string): Promise<Stream> => {
  const ac = new AbortController();
  const res = await fetch(`${base}/mcp?token=${token}`, {
    method: 'GET',
    signal: ac.signal,
    headers: {
      accept: 'text/event-stream',
      'mcp-session-id': sessionId,
      'mcp-protocol-version': '2025-06-18',
    },
  });
  let raw = '';
  let ended = false;
  const reader = res.body?.getReader();
  const decoder = new TextDecoder();
  const pump = (async () => {
    if (!reader) return;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          ended = true;
          break;
        }
        raw += decoder.decode(value, { stream: true });
      }
    } catch {
      ended = true;
    }
  })();
  return {
    raw: () => raw,
    status: res.status,
    ended: () => ended,
    stop: async () => {
      ac.abort();
      await pump;
    },
  };
};

const waitFor = async (predicate: () => boolean, ms = 5000): Promise<void> => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
};

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 150));

const doReset = (email: string, id: number): Promise<Response> =>
  fetch(`${base}/api/agents/${id}/key`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${session(email)}`,
      connection: 'close',
    },
  });

beforeAll(async () => {
  priorStations = process.env.METRO_CHANNEL_STATIONS;
  process.env.METRO_CHANNEL_STATIONS = 'whatsapp';
  process.env.METRO_SESSION_SECRET = SECRET;
  attachDir = mkdtempSync(join(tmpdir(), 'metro-keyreset-'));
  writeFileSync(join(attachDir, ADA_FILE), PNG);
  writeFileSync(join(attachDir, BOB_FILE), PNG);
  process.env.METRO_XMTP_ATTACH_DIR = attachDir;
  process.env.METRO_PUBLIC_URL = 'https://mcp.metro.box';
  process.env.METRO_WEBHOOK_PORT = String(
    20000 + Math.floor(Math.random() * 20000),
  );
  process.env.METRO_HTTP_HOST = '127.0.0.1';
  keys = { [ADA]: mint(ADA), [BOB]: mint(BOB) };
  setKeyMap([
    { key: keys[ADA] ?? '', agentId: ADA },
    { key: keys[BOB] ?? '', agentId: BOB },
  ]);
  setAgentMap(
    { [`whatsapp/${ADA_ACCOUNT}`]: ADA, [`whatsapp/${BOB_ACCOUNT}`]: BOB },
    { [ADA]: 'ada-bot', [BOB]: 'bob-bot' },
  );
  const mcp = await createMetroMcp();
  server = await startWebhookServer(
    makeEmit(),
    mcp.httpHandler,
    () => Promise.resolve({ result: 'ok' }),
    deps,
  );
  mcp.startInbound();
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  adaUrl = attachmentUrl(ADA_FILE, ADA) ?? '';
  bobUrl = attachmentUrl(BOB_FILE, BOB) ?? '';
});

afterAll(async () => {
  if (server) {
    const live = server;
    await Promise.race([
      new Promise<void>((r) => live.close(() => r())),
      new Promise<void>((r) => setTimeout(r, 2000).unref()),
    ]);
  }
  if (priorStations === undefined) delete process.env.METRO_CHANNEL_STATIONS;
  else process.env.METRO_CHANNEL_STATIONS = priorStations;
  delete process.env.METRO_SESSION_SECRET;
  delete process.env.METRO_XMTP_ATTACH_DIR;
  delete process.env.METRO_PUBLIC_URL;
  setKeyMap([]);
  setAgentMap({}, {});
});

const localise = (url: string): string => url.replace('https://mcp.metro.box', base);

describe('resetting a key revokes the old one everywhere', () => {
  test('the old key stops authenticating on mcp, tail and attach; the new one works', async () => {
    const old = keys[ADA] ?? '';
    expect(agentIdForKey(old)).toBe(ADA);
    expect((await mcpProbe(old)).status).toBe(200);
    expect(await status(`${base}/api/tail?token=${old}`)).toBe(200);
    expect(await status(`${base}/attach/${ADA_FILE}?token=${old}`)).toBe(200);

    const res = await doReset('ada@lovelace.dev', ADA);
    expect(res.status).toBe(200);
    const fresh = ((await res.json()) as { key: string }).key;
    expect(fresh).not.toBe(old);

    expect(agentIdForKey(old)).toBeUndefined();
    expect(agentIdForKey(fresh)).toBe(ADA);
    expect((await mcpProbe(old)).status).toBe(401);
    expect(await status(`${base}/api/tail?token=${old}`)).toBe(401);
    expect(await status(`${base}/attach/${ADA_FILE}?token=${old}`)).toBe(401);
    expect(
      await status(`${base}/mcp`, { authorization: `Bearer ${old}` }),
    ).toBe(401);

    expect((await mcpProbe(fresh)).status).toBe(200);
    expect(await status(`${base}/api/tail?token=${fresh}`)).toBe(200);
    expect(await status(`${base}/attach/${ADA_FILE}?token=${fresh}`)).toBe(200);
  }, 30000);

  test('the other agent key is untouched by the rotation', async () => {
    const bob = keys[BOB] ?? '';
    await doReset('ada@lovelace.dev', ADA);
    expect(agentIdForKey(bob)).toBe(BOB);
    expect((await mcpProbe(bob)).status).toBe(200);
    expect(await status(`${base}/api/tail?token=${bob}`)).toBe(200);
    expect(await status(`${base}/attach/${BOB_FILE}?token=${bob}`)).toBe(200);
  }, 30000);

  test('a non-owner cannot reset another agent key and nothing rotates', async () => {
    const bob = keys[BOB] ?? '';
    const res = await doReset('ada@lovelace.dev', BOB);
    expect(res.status).toBe(404);
    expect(keys[BOB]).toBe(bob);
    expect(agentIdForKey(bob)).toBe(BOB);
    expect((await mcpProbe(bob)).status).toBe(200);
  }, 30000);

  test('a rotated key never resolves to another agent', async () => {
    const stale = keys[ADA] ?? '';
    await doReset('ada@lovelace.dev', ADA);
    expect(agentIdForKey(stale)).toBeUndefined();
    expect(await status(`${base}/attach/${BOB_FILE}?token=${stale}`)).toBe(401);
  }, 30000);
});

describe('attachment links survive a key reset', () => {
  test('a url minted before the reset still serves afterwards', async () => {
    expect(adaUrl).toContain('token=at_');
    expect(adaUrl).not.toContain(keys[ADA] ?? 'unset');
    expect(await status(localise(adaUrl))).toBe(200);
    await doReset('ada@lovelace.dev', ADA);
    expect(await status(localise(adaUrl))).toBe(200);
  }, 30000);

  test('another agent attachment token is unaffected and still scoped', async () => {
    await doReset('ada@lovelace.dev', ADA);
    expect(await status(localise(bobUrl))).toBe(200);
    const swapped = localise(bobUrl).replace(BOB_FILE, ADA_FILE);
    expect(await status(swapped)).toBe(401);
  }, 30000);
});

describe('the live session of a rotated agent', () => {
  test('is closed at the wire, and the other agent stream survives', async () => {
    const adaKey = keys[ADA] ?? '';
    const bobKey = keys[BOB] ?? '';
    const adaSession = await initSession(adaKey);
    const bobSession = await initSession(bobKey);
    const ada = await openGet(adaKey, adaSession);
    const bob = await openGet(bobKey, bobSession);
    await settle();

    const before = `before-${randomUUID()}`;
    publishEvent(msg(ADA_LINE, before));
    await waitFor(() => ada.raw().includes(before));

    await doReset('ada@lovelace.dev', ADA);
    await waitFor(() => ada.ended());
    expect(ada.ended()).toBe(true);
    expect(bob.ended()).toBe(false);

    const stale = await fetch(`${base}/mcp?token=${adaKey}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': adaSession,
        'mcp-protocol-version': '2025-06-18',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    expect(stale.status).toBe(401);
    await stale.body?.cancel();

    const bobText = `bob-still-here-${randomUUID()}`;
    publishEvent(msg(BOB_LINE, bobText));
    await waitFor(() => bob.raw().includes(bobText));
    expect(bob.raw()).toContain(bobText);

    await ada.stop();
    await bob.stop();
  }, 30000);

  test('the reconnecting agent gets the message it missed while rotated out', async () => {
    const oldKey = keys[ADA] ?? '';
    const first = await initSession(oldKey);
    const stream = await openGet(oldKey, first);
    await settle();

    await doReset('ada@lovelace.dev', ADA);
    await waitFor(() => stream.ended());

    const gap = `gap-${randomUUID()}`;
    publishEvent(msg(ADA_LINE, gap));
    await settle();

    const fresh = keys[ADA] ?? '';
    const second = await initSession(fresh);
    expect(second).not.toBe(first);
    const reconnected = await openGet(fresh, second);
    await waitFor(() => reconnected.raw().includes(gap));
    const body = reconnected.raw();
    await stream.stop();
    await reconnected.stop();
    expect(body).toContain(gap);
  }, 30000);
});
