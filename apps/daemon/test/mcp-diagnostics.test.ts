import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createMetroMcp } from '../src/mcp/index.ts';
import { diagnosticTag, handleIncomingDiagnostic, type IncomingDiagnostic } from '../src/mcp/diagnostics.ts';
import { allowedAgents, authenticate } from '../src/mcp/request-identity.ts';
import { trainEventToMetroEvent } from '../src/routes/http.ts';
import { parseTrainLine } from '@metro-labs/core/trains/protocol';
import { SessionSlot } from '../src/mcp/session-slot.ts';
import { setKeyMap } from '../src/agents/keys.ts';
import { setAgentMap, setDisabledAccounts } from '../src/agents/map.ts';
import { publishEvent, type MetroEvent } from '@metro-labs/core/events';
import { asLine } from '@metro-labs/core/lines';
import { bootDaemon, type Daemon } from './http-harness.ts';
import { openGet } from './mcp-probe.ts';
import { settle, waitFor } from './wait.ts';

const TOKEN = 'mk_diagnostic_fixture';
const OTHER_TOKEN = 'mk_diagnostic_other_fixture';
const ACCOUNT = 'diagnostic-account-private';
const OTHER_ACCOUNT = 'diagnostic-other-private';
const LINE = `metro://xmtp/${ACCOUNT}/private-conversation`;
let daemon: Daemon;
let mcp: Awaited<ReturnType<typeof createMetroMcp>>;

beforeEach(async () => {
  setKeyMap([{ key: TOKEN, agentId: 'agent000001' }, { key: OTHER_TOKEN, agentId: 'agent000002' }]);
  setAgentMap({ [`xmtp/${ACCOUNT}`]: 'agent000001', [`xmtp/${OTHER_ACCOUNT}`]: 'agent000002' }, {});
  mcp = await createMetroMcp();
  mcp.startInbound();
  daemon = await bootDaemon({}, { mcp: mcp.httpHandler });
});

afterEach(async () => {
  await createMetroMcp();
  await daemon.close();
  setKeyMap([]);
  setAgentMap({}, {});
  setDisabledAccounts(new Set());
});

const statusResponse = (headers: Record<string, string> = {}, method = 'GET'): Promise<Response> =>
  fetch(`${daemon.base}/mcp/status`, { method, signal: AbortSignal.timeout(1000), headers: { authorization: `Bearer ${TOKEN}`, ...headers } });

async function status(token = TOKEN): Promise<IncomingDiagnostic> {
  const res = await statusResponse({ authorization: `Bearer ${token}` });
  expect(res.status).toBe(200);
  expect(res.headers.get('cache-control')).toBe('no-store');
  return res.json();
}

async function initialize(name = 'claude-code', version = '2.1.296'): Promise<string> {
  const res = await fetch(`${daemon.base}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name, version } } }),
  });
  const id = res.headers.get('mcp-session-id');
  await res.body?.cancel();
  if (id === null) throw new Error('fixture initialize returned no session');
  return id;
}

async function initialized(id: string): Promise<void> {
  const res = await fetch(`${daemon.base}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': id },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
  await res.body?.cancel();
}

const event = (line: string, messageId: string): MetroEvent => ({
  id: messageId,
  messageId,
  station: 'xmtp',
  ts: '2026-10-13T12:09:06.273Z',
  line: asLine(line),
  from: asLine('metro://xmtp/private-account/user/private-sender'),
  to: asLine(line),
  text: 'private message content',
  payload: { secret: 'private attachment metadata' },
});

describe('content-free incoming diagnostics', () => {
  test('requires local agent authentication, not owner tokens or forwarded requests', async () => {
    for (const headers of [{ authorization: '' }, { authorization: 'Bearer wrong' }, { 'x-forwarded-for': '127.0.0.1' }, { 'tailscale-funnel-request': 'true' }]) {
      const res = await statusResponse(headers);
      expect(res.status).toBe(401);
      expect(await res.text()).toBe('unauthorized');
    }
    expect((await statusResponse({}, 'POST')).status).toBe(405);
    expect((await status()).current).toBeNull();
  });

  test('does not initialize, adopt or open a GET stream even with a stale id and SSE accept', async () => {
    const res = await statusResponse({ 'mcp-session-id': 'private-stale-session', accept: 'text/event-stream' });
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.headers.get('mcp-session-id')).toBeNull();
    const snapshot: IncomingDiagnostic = await res.json();
    expect(snapshot.started).toBe(true);
    expect(snapshot.current).toBeNull();
    expect(snapshot.replacements).toEqual([]);
    expect((await status()).current).toBeNull();
  });

  test('reports handshake readiness, stable slot and GET mapping ownership without displacing it', async () => {
    const id = await initialize();
    await initialized(id);
    const stream = await openGet(`${daemon.base}/mcp?token=${TOKEN}`, id);
    try {
      await settle(30);
      const first = await status();
      expect(first.current).toMatchObject({ tag: diagnosticTag(id), transportInitialized: true, subscribed: true, streamAttached: true, client: { kind: 'claude-code' }, stream: { ownsMapping: true, closedAt: null } });
      expect(first.current?.clientInitializedAt).toBeString();
      expect(first.current?.lastStreamAttachedAt).toBeString();
      expect(first.current?.stream?.attachedAt).toBeString();
      const res = await statusResponse({ 'mcp-session-id': 'another-private-stale-id', accept: 'text/event-stream' });
      const second: IncomingDiagnostic = await res.json();
      expect(second.current).toEqual(first.current);
      expect(second.replacements).toEqual(first.replacements);
      expect(stream.ended()).toBe(false);
      expect(JSON.stringify(second)).not.toContain(id);
    } finally {
      await stream.stop();
    }
  });

  test('records an intentional tool-only initialize takeover without changing that contract', async () => {
    const firstId = await initialize();
    const stream = await openGet(`${daemon.base}/mcp?token=${TOKEN}`, firstId);
    try {
      await settle(30);
      const secondId = await initialize('private-client-name', 'private-client-version');
      await waitFor(() => stream.ended());
      const snapshot = await status();
      expect(snapshot.current).toMatchObject({ tag: diagnosticTag(secondId), transportInitialized: true, streamAttached: false, client: { kind: 'other' }, stream: null });
      expect(snapshot.replacements.at(-1)).toMatchObject({ reason: 'initialize', tag: diagnosticTag(secondId), previous: { tag: diagnosticTag(firstId), streamAttached: true, client: { kind: 'claude-code' }, stream: { ownsMapping: true } } });
      const serialized = JSON.stringify(snapshot);
      for (const value of [firstId, secondId, 'private-client-name', 'private-client-version']) expect(serialized).not.toContain(value);
    } finally {
      await stream.stop();
    }
  });

  test('reports detachment and keeps status reads independent from live messages', async () => {
    const id = await initialize();
    const stream = await openGet(`${daemon.base}/mcp?token=${TOKEN}`, id);
    await settle(30);
    await stream.stop();
    await settle(30);
    mcp.setLiveEvents(false);
    const snapshot = await status();
    expect(snapshot.liveEvents).toBe(false);
    expect(snapshot.current).toMatchObject({ tag: diagnosticTag(id), streamAttached: false, subscribed: false, stream: null });
    expect(snapshot.current?.lastStreamDetachedAt).toBeString();
  });

  test('scopes slot, replacement and bus metadata and emits no content, sender, line or credentials', async () => {
    const id = await initialize('private-client-name', 'private-client-version');
    publishEvent(event(LINE, 'private-event-id'));
    publishEvent(event(`metro://xmtp/${OTHER_ACCOUNT}/private-other-conversation`, 'private-other-event-id'));
    setDisabledAccounts(new Set([`xmtp/${ACCOUNT}`]));
    const mine = await status();
    expect(mine.accounts).toEqual([{ station: 'xmtp', tag: diagnosticTag(JSON.stringify(['xmtp', ACCOUNT])), receiveEnabled: false, bufferedEvents: 1, latestEventAt: '2026-10-13T12:09:06.273Z', latestEventTag: diagnosticTag('private-event-id') }]);
    const other = await status(OTHER_TOKEN);
    expect(other.current).toBeNull();
    expect(other.replacements).toEqual([]);
    expect(other.accounts[0]?.latestEventTag).toBe(diagnosticTag('private-other-event-id'));
    expect((await status()).current?.tag).toBe(diagnosticTag(id));
    const serialized = JSON.stringify([mine, other]);
    for (const value of [TOKEN, OTHER_TOKEN, ACCOUNT, OTHER_ACCOUNT, LINE, 'private-sender', 'private message content', 'private attachment metadata', 'private-event-id', 'private-client-name', 'private-client-version']) expect(serialized).not.toContain(value);
  });

  test('ignores malformed buffered lines and never exposes invalid event timestamps', async () => {
    const before = (await status()).accounts[0]?.bufferedEvents ?? 0;
    publishEvent({ ...event(LINE, 'malformed-private-id'), line: 17 } as unknown as MetroEvent);
    publishEvent({ ...event(LINE, 'valid-private-id'), ts: 'private invalid timestamp' });
    const snapshot = await status();
    expect(snapshot.accounts).toEqual([{ station: 'xmtp', tag: diagnosticTag(JSON.stringify(['xmtp', ACCOUNT])), receiveEnabled: true, bufferedEvents: before + 1, latestEventAt: null, latestEventTag: diagnosticTag('valid-private-id') }]);
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain('private invalid timestamp');
    expect(serialized).not.toContain('malformed-private-id');
  });

  test.each([
    { name: 'numeric message id', metadata: { message_id: 42, id: 'private-fallback-id', ts: '2026-10-13T12:09:06.273Z' }, id: 'private-fallback-id', at: '2026-10-13T12:09:06.273Z' },
    { name: 'object timestamp', metadata: { message_id: 'private-message-id', id: 42, ts: { toString: 'invalid' } }, id: 'private-message-id', at: null },
    { name: 'invalid identifiers', metadata: { message_id: { toString: 'private-invalid-id' }, id: 42, ts: false }, id: null, at: null },
    { name: 'empty message id', metadata: { message_id: '', id: 'private-fallback-id', ts: 0 }, id: 'private-fallback-id', at: null },
    { name: 'array metadata', metadata: { message_id: [], id: {}, ts: ['2026-10-13T12:09:06.273Z'] }, id: null, at: null },
    { name: 'valid message id takes precedence', metadata: { message_id: 'private-message-id', id: 'private-fallback-id', ts: '2026-10-13T12:09:06.273Z' }, id: 'private-message-id', at: '2026-10-13T12:09:06.273Z' },
  ])('completes authenticated status for malformed train metadata: $name', async ({ name, metadata, id, at }) => {
    const account = `${ACCOUNT}-${name.replace(/ /g, '-')}`;
    const line = `metro://xmtp/${account}/private-conversation`;
    setAgentMap({ [`xmtp/${account}`]: 'agent000001', [`xmtp/${OTHER_ACCOUNT}`]: 'agent000002' }, {});
    const before = (await status()).accounts[0]?.bufferedEvents ?? 0;
    const parsed = parseTrainLine('xmtp', JSON.stringify({ ...event(line, 'private-wire-id'), ...metadata }));
    if (parsed?.op !== 'event') throw new Error('fixture train event was not parsed');
    const converted = trainEventToMetroEvent(parsed.event, 'xmtp');
    if (converted === null) throw new Error('fixture train event was not converted');
    expect(converted.messageId).toEqual(metadata.message_id);
    expect(converted.ts).toEqual(metadata.ts);
    publishEvent(converted);
    const res = await statusResponse({ 'mcp-session-id': 'private-stale-session', accept: 'text/event-stream' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('mcp-session-id')).toBeNull();
    const body = await res.text();
    const snapshot = JSON.parse(body) as IncomingDiagnostic;
    expect(snapshot.current).toBeNull();
    expect(snapshot.replacements).toEqual([]);
    expect(snapshot.accounts[0]).toMatchObject({ bufferedEvents: before + 1, latestEventAt: at, latestEventTag: id === null ? null : diagnosticTag(id) });
    for (const value of [TOKEN, OTHER_TOKEN, ACCOUNT, OTHER_ACCOUNT, LINE, 'private-sender', 'private message content', 'private attachment metadata', 'private-wire-id', 'private-fallback-id', 'private-message-id', 'private-invalid-id', 'private-stale-session', 'invalid']) expect(body).not.toContain(value);
  });

  test.each(['snapshot', 'serialization'])('finishes an HTTP error before sending headers when %s fails', async (failure) => {
    const fixture = await bootDaemon({}, {
      mcp: async (req, res) => {
        const identity = authenticate(req);
        if (identity === null) {
          res.writeHead(401).end('unauthorized');
          return;
        }
        handleIncomingDiagnostic(req, res, {
          diagnostics: () => {
            if (failure === 'snapshot') throw new Error('private diagnostic failure');
            return { started: true, liveEvents: true, current: null, replacements: [], toJSON: () => { throw new Error('private diagnostic failure'); } };
          },
        }, allowedAgents(identity));
      },
    });
    try {
      const res = await fetch(`${fixture.base}/mcp/status`, { headers: { authorization: `Bearer ${TOKEN}` }, signal: AbortSignal.timeout(1000) });
      expect(res.status).toBe(500);
      expect(res.headers.get('content-type')).not.toBe('application/json');
      expect(res.headers.get('mcp-session-id')).toBeNull();
      expect(await res.text()).toBe('');
    } finally {
      fixture.server.closeAllConnections();
      await fixture.close();
    }
  });

  test('bounds replacement history and hides another scope in a previous slot', async () => {
    const slot = new SessionSlot();
    try {
      for (let i = 0; i < 10; i++) await slot.open({ kind: 'agent', agentId: 'agent000001' }, `private-adopted-id-${i}`);
      expect(slot.diagnostics(new Set(['agent000001'])).replacements).toHaveLength(8);
      await slot.open({ kind: 'agent', agentId: 'agent000002' }, 'other-private-adopted-id');
      const other = slot.diagnostics(new Set(['agent000002']));
      expect(other.replacements).toHaveLength(1);
      expect(other.replacements[0]?.reason).toBe('adopt');
      expect(other.replacements[0]?.previous).toBeNull();
      expect(other.current).toMatchObject({ transportInitialized: true, clientInitializedAt: null, client: null });
    } finally {
      await slot.close();
    }
  });
});
