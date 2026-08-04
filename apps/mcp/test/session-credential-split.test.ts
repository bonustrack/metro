/**
 * Two agents, two owners, over real HTTP: an `agents.key` client and the
 * owner's Google login hold SEPARATE sessions on the same one agent.
 *
 * Found verifying #130. Sessions were keyed by scope alone, so an agent key and
 * a Google session scoped to exactly that agent collided into one session, and
 * the key reset's `closeAgentSession(id)` closed the browser login with it. A
 * multi-agent login survived only because its scope key differed. Rotating an
 * API key must not touch a sign-in: they are separate credentials.
 *
 * Both streams here are live at once against the real `createMetroMcp` and the
 * real `POST /api/agents/<id>/key` route, so this also pins that the two
 * sessions keep SEPARATE replay ledgers — sharing one would let whichever
 * session enqueued an event first swallow it for the other.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { makeEmit, startWebhookServer } from '../src/daemon/http.ts';
import { signSession } from '../src/daemon/session.ts';
import { publishEvent, type MetroEvent } from '../src/daemon/events.ts';
import { asLine } from '../src/stations/lines.ts';
import { closeAgentSession, createMetroMcp } from '../src/mcp/index.ts';
import { rotateAgentKey, setKeyMap } from '../src/db/key-map.ts';
import { setAgentMap } from '../src/db/agent-map.ts';
import { AgentAdminError } from '../src/db/agent-admin.ts';
import type { AgentApiDeps } from '../src/daemon/agent-api.ts';

const SECRET = 'credential-split-test-secret';
const TONY = 1;
const LISA = 34;
const TONY_ACCOUNT = 'a1-splittony';
const LISA_ACCOUNT = 'a34-splitlisa';
const TONY_LINE = `metro://whatsapp/${TONY_ACCOUNT}/111@lid`;
const LISA_LINE = `metro://whatsapp/${LISA_ACCOUNT}/222@lid`;

const OWNERS: Record<number, string> = {
  [TONY]: 'tony@example.test',
  [LISA]: 'lisa@example.test',
};

let keys: Record<number, string> = {};
let server: Server | undefined;
let base = '';
let priorStations: string | undefined;

const mint = (agentId: number): string =>
  `mk_split_${agentId}_${randomUUID().replace(/-/g, '')}`;

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

const unused = (): Promise<never> =>
  Promise.reject(new AgentAdminError('not here', 400));

const deps: AgentApiDeps = {
  listAgents: () => Promise.resolve([]),
  createAgent: unused,
  deleteAgent: unused,
  resetKey,
  gatherAccounts: () => Promise.resolve({}),
  capabilities: () => ({}),
  attachSessions: {
    start: unused,
    view: () => {
      throw new AgentAdminError('not here', 400);
    },
    submit: unused,
    cancel: unused,
  },
  prepareAccount: unused,
  attachAccount: unused,
  detachAccount: unused,
  syncStations: () => Promise.resolve(),
};

const login = (email: string, agentIds: number[]): string =>
  signSession({ email, agentIds }, SECRET);

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

const initSession = async (token: string): Promise<string> => {
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
  if (!sessionId) throw new Error(`no session id (status ${res.status})`);
  return sessionId;
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
      authorization: `Bearer ${login(email, [id])}`,
      connection: 'close',
    },
  });

beforeAll(async () => {
  priorStations = process.env.METRO_CHANNEL_STATIONS;
  process.env.METRO_CHANNEL_STATIONS = 'whatsapp';
  process.env.METRO_SESSION_SECRET = SECRET;
  process.env.METRO_WEBHOOK_PORT = String(
    41000 + Math.floor(Math.random() * 8000),
  );
  process.env.METRO_HTTP_HOST = '127.0.0.1';
  keys = { [TONY]: mint(TONY), [LISA]: mint(LISA) };
  setKeyMap([
    { key: keys[TONY] ?? '', agentId: TONY },
    { key: keys[LISA] ?? '', agentId: LISA },
  ]);
  setAgentMap(
    { [`whatsapp/${TONY_ACCOUNT}`]: TONY, [`whatsapp/${LISA_ACCOUNT}`]: LISA },
    { [TONY]: 'Tony', [LISA]: 'Lisa' },
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
  setKeyMap([]);
  setAgentMap({}, {});
});

describe('an agent key and its owner login on the same agent', () => {
  test('are two sessions, both open, and BOTH receive that agent traffic', async () => {
    const keyId = await initSession(keys[TONY] ?? '');
    const loginId = await initSession(login(OWNERS[TONY] ?? '', [TONY]));
    expect(keyId).not.toBe(loginId);

    const byKey = await openGet(keys[TONY] ?? '', keyId);
    const byLogin = await openGet(login(OWNERS[TONY] ?? '', [TONY]), loginId);
    expect(byKey.status).toBe(200);
    expect(byLogin.status).toBe(200);
    await settle();

    const text = `both-${randomUUID()}`;
    publishEvent(msg(TONY_LINE, text));
    await waitFor(
      () => byKey.raw().includes(text) && byLogin.raw().includes(text),
    );

    const keyBody = byKey.raw();
    const loginBody = byLogin.raw();
    expect(byKey.ended()).toBe(false);
    expect(byLogin.ended()).toBe(false);
    await byKey.stop();
    await byLogin.stop();

    expect(keyBody).toContain(text);
    expect(loginBody).toContain(text);
  }, 30000);

  test('neither can attach to the other session id', async () => {
    const keyToken = keys[TONY] ?? '';
    const loginToken = login(OWNERS[TONY] ?? '', [TONY]);
    const keyId = await initSession(keyToken);
    const loginId = await initSession(loginToken);
    const byLogin = await openGet(loginToken, loginId);
    await settle();

    const secret = `login-only-${randomUUID()}`;
    publishEvent(msg(TONY_LINE, secret));
    await waitFor(() => byLogin.raw().includes(secret));

    const stolenGet = await fetch(`${base}/mcp?token=${keyToken}`, {
      method: 'GET',
      headers: {
        accept: 'text/event-stream',
        'mcp-session-id': loginId,
        'mcp-protocol-version': '2025-06-18',
      },
    });
    const stolenGetBody = await stolenGet.text();

    const stolenPost = await fetch(`${base}/mcp?token=${loginToken}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': keyId,
        'mcp-protocol-version': '2025-06-18',
        connection: 'close',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    const stolenPostBody = await stolenPost.text();

    expect(byLogin.ended()).toBe(false);
    await byLogin.stop();

    expect(stolenGet.status).toBe(404);
    expect(stolenGetBody).toBe('Session not found');
    expect(stolenGetBody).not.toContain(secret);
    expect(stolenPost.status).toBe(404);
    expect(stolenPostBody).not.toContain(secret);
  }, 30000);

  test('no crossover: another agent traffic reaches neither of them', async () => {
    const keyToken = keys[TONY] ?? '';
    const loginToken = login(OWNERS[TONY] ?? '', [TONY]);
    const byKey = await openGet(keyToken, await initSession(keyToken));
    const byLogin = await openGet(loginToken, await initSession(loginToken));
    const lisaToken = keys[LISA] ?? '';
    const lisa = await openGet(lisaToken, await initSession(lisaToken));
    await settle();

    const mine = `tony-only-${randomUUID()}`;
    const hers = `lisa-only-${randomUUID()}`;
    publishEvent(msg(TONY_LINE, mine));
    publishEvent(msg(LISA_LINE, hers));
    await waitFor(
      () =>
        byKey.raw().includes(mine) &&
        byLogin.raw().includes(mine) &&
        lisa.raw().includes(hers),
    );

    const keyBody = byKey.raw();
    const loginBody = byLogin.raw();
    const lisaBody = lisa.raw();
    await byKey.stop();
    await byLogin.stop();
    await lisa.stop();

    expect(keyBody).toContain(mine);
    expect(loginBody).toContain(mine);
    expect(keyBody).not.toContain(hers);
    expect(loginBody).not.toContain(hers);
    expect(keyBody).not.toContain(LISA_ACCOUNT);
    expect(loginBody).not.toContain(LISA_ACCOUNT);
    expect(lisaBody).toContain(hers);
    expect(lisaBody).not.toContain(mine);
    expect(lisaBody).not.toContain(TONY_ACCOUNT);
  }, 30000);
});

describe('a key reset closes the agent key session only', () => {
  test('the login keeps its stream and keeps receiving', async () => {
    const loginToken = login(OWNERS[TONY] ?? '', [TONY]);
    const keyId = await initSession(keys[TONY] ?? '');
    const byKey = await openGet(keys[TONY] ?? '', keyId);
    const byLogin = await openGet(loginToken, await initSession(loginToken));
    await settle();

    const before = `before-reset-${randomUUID()}`;
    publishEvent(msg(TONY_LINE, before));
    await waitFor(
      () => byKey.raw().includes(before) && byLogin.raw().includes(before),
    );

    const res = await doReset(OWNERS[TONY] ?? '', TONY);
    expect(res.status).toBe(200);
    await res.body?.cancel();

    await waitFor(() => byKey.ended());
    expect(byKey.ended()).toBe(true);
    expect(byLogin.ended()).toBe(false);

    const after = `after-reset-${randomUUID()}`;
    publishEvent(msg(TONY_LINE, after));
    await waitFor(() => byLogin.raw().includes(after));

    const loginBody = byLogin.raw();
    const keyBody = byKey.raw();
    await byKey.stop();
    await byLogin.stop();

    expect(loginBody).toContain(before);
    expect(loginBody).toContain(after);
    expect(keyBody).toContain(before);
    expect(keyBody).not.toContain(after);
  }, 30000);

  test('a multi-agent login is unaffected, as it always was', async () => {
    const ops = login('ops@example.test', [TONY, LISA]);
    const opsStream = await openGet(ops, await initSession(ops));
    const keyId = await initSession(keys[TONY] ?? '');
    const byKey = await openGet(keys[TONY] ?? '', keyId);
    await settle();

    const res = await doReset(OWNERS[TONY] ?? '', TONY);
    expect(res.status).toBe(200);
    await res.body?.cancel();
    await waitFor(() => byKey.ended());

    const after = `ops-after-${randomUUID()}`;
    publishEvent(msg(TONY_LINE, after));
    await waitFor(() => opsStream.raw().includes(after));

    expect(opsStream.ended()).toBe(false);
    const opsBody = opsStream.raw();
    await opsStream.stop();
    await byKey.stop();
    expect(opsBody).toContain(after);
  }, 30000);

  test('the rotated agent reconnects and gets what it missed', async () => {
    const stale = keys[TONY] ?? '';
    const first = await initSession(stale);
    const dropped = await openGet(stale, first);
    await settle();

    const res = await doReset(OWNERS[TONY] ?? '', TONY);
    expect(res.status).toBe(200);
    await res.body?.cancel();
    await waitFor(() => dropped.ended());

    const gap = `gap-${randomUUID()}`;
    publishEvent(msg(TONY_LINE, gap));
    await settle();

    const fresh = keys[TONY] ?? '';
    expect(fresh).not.toBe(stale);
    const second = await initSession(fresh);
    expect(second).not.toBe(first);
    const reconnected = await openGet(fresh, second);
    await waitFor(() => reconnected.raw().includes(gap));

    const body = reconnected.raw();
    await dropped.stop();
    await reconnected.stop();
    expect(body).toContain(gap);
  }, 30000);
});
