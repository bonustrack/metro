import { describe, expect, test } from 'bun:test';
import { listRemoteServer } from '../src/connector-tools.ts';
import { CURSOR_MAX, declaresEvents, eventSenderOf, EVENTS_EXTENSION, pointerValue, senderPointersOf, subscribeParams, subscribeResultOf, unsubscribeParams, webhookBodyOf } from '../src/mcp-events.ts';
import { mcpInboxOf, mcpSettledOf } from '../src/mcp-server-protocol.ts';
import { normalizeSenderList, senderListOf, senderVerdict } from '../src/sender-list.ts';
import { isWebhookSecret, newWebhookSecret, webhookFresh, webhookHeadersOf, webhookSignature, webhookSigned } from '../src/standard-webhooks.ts';

describe('Standard Webhooks', () => {
  const secret = `whsec_${Buffer.alloc(24, 7).toString('base64')}`;
  const body = Buffer.from('{"a":1}');

  test('a secret is whsec_ and 24 to 64 bytes of canonical base64', () => {
    expect(isWebhookSecret(newWebhookSecret())).toBe(true);
    expect(isWebhookSecret(secret)).toBe(true);
    for (const bad of ['', 'secret', `whsec_${Buffer.alloc(23).toString('base64')}`, `whsec_${Buffer.alloc(65).toString('base64')}`, 'whsec_!!!!', `whsec_${Buffer.alloc(24).toString('base64url')}-`]) expect(isWebhookSecret(bad)).toBe(false);
    expect(() => webhookSignature('whsec_short', 'id', 1, body)).toThrow();
  });

  test('the signature is HMAC-SHA256 over id.timestamp.body with the decoded secret (the published test vector)', () => {
    const vector = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
    const payload = '{"test": 2432232314}';
    expect(webhookSignature(vector, 'msg_p5jXN8AQM9LWM0D4loKWxJek', 1614265330, payload)).toBe('v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=');
  });

  test('headers are read strictly: an id of letters, digits, _ and -, seconds, a signature and the subscription id', () => {
    const headers = { 'webhook-id': 'msg_1-a', 'webhook-timestamp': '1700000000', 'webhook-signature': 'v1,abc', 'x-mcp-subscription-id': 'sub_1' };
    expect(webhookHeadersOf(headers)).toEqual({ id: 'msg_1-a', timestamp: 1_700_000_000, signature: 'v1,abc', subscription: 'sub_1' });
    for (const [name, value] of [['webhook-id', 'has.dot'], ['webhook-id', ''], ['webhook-timestamp', '1.5'], ['webhook-timestamp', '-1'], ['webhook-signature', ''], ['webhook-signature', 'x'.repeat(5000)], ['x-mcp-subscription-id', 'has space'], ['x-mcp-subscription-id', '']] as const)
      expect(webhookHeadersOf({ ...headers, [name]: value })).toBeNull();
  });

  test('a delivery is fresh for 5 minutes either way, and any one v1 signature that verifies is enough', () => {
    const timestamp = 1_700_000_000;
    const headers = { id: 'msg_1', timestamp, signature: webhookSignature(secret, 'msg_1', timestamp, body), subscription: 'sub_1' };
    expect(webhookFresh(headers, timestamp * 1000 + 5 * 60_000)).toBe(true);
    expect(webhookFresh(headers, timestamp * 1000 + 5 * 60_000 + 1)).toBe(false);
    expect(webhookFresh(headers, timestamp * 1000 - 5 * 60_000 - 1)).toBe(false);
    expect(webhookSigned(secret, headers, body)).toBe(true);
    expect(webhookSigned(secret, { ...headers, signature: `v1,AAAA v1a,zzz ${headers.signature}` }, body)).toBe(true);
    expect(webhookSigned(secret, headers, Buffer.from('{"a":2}'))).toBe(false);
    expect(webhookSigned(secret, { ...headers, id: 'msg_2' }, body)).toBe(false);
    expect(webhookSigned(secret, { ...headers, timestamp: timestamp + 1 }, body)).toBe(false);
    expect(webhookSigned(newWebhookSecret(), headers, body)).toBe(false);
    expect(webhookSigned(secret, { ...headers, signature: headers.signature.replace('v1,', 'v2,') }, body)).toBe(false);
    expect(webhookSigned('not-a-secret', headers, body)).toBe(false);
  });
});

describe('the events extension', () => {
  test('is detected only at capabilities.extensions["io.modelcontextprotocol/events"]', () => {
    expect(declaresEvents({ capabilities: { extensions: { [EVENTS_EXTENSION]: {} } } })).toBe(true);
    expect(declaresEvents({ capabilities: { extensions: { [EVENTS_EXTENSION]: { listChanged: true } } } })).toBe(true);
    for (const other of [{}, { capabilities: {} }, { capabilities: { events: {} } }, { capabilities: { experimental: { events: {} } } }, { capabilities: { extensions: { [EVENTS_EXTENSION]: true } } }, { capabilities: { extensions: { 'other/ext': {} } } }])
      expect(declaresEvents(other)).toBe(false);
  });

  test('sender pointers are JSON Pointers into data, and a bad one means no sender', () => {
    expect(senderPointersOf({ 'box.metro/sender': { id: '/from/address', verified: '/senderVerified' } })).toEqual({ id: '/from/address', verified: '/senderVerified' });
    expect(senderPointersOf({ 'box.metro/sender': { id: '/from' } })).toEqual({ id: '/from' });
    expect(senderPointersOf({ 'box.metro/sender': { id: '/from', verified: 'nope' } })).toEqual({ id: '/from' });
    for (const bad of [undefined, {}, { 'box.metro/sender': 'x' }, { 'box.metro/sender': { id: 'from' } }, { 'box.metro/sender': { id: '' } }, { 'box.metro/sender': { id: '/a/~2' } }, { 'box.metro/sender': { id: `/${'a/'.repeat(9)}b` } }]) expect(senderPointersOf(bad)).toBeNull();
  });

  test('a pointer reads own keys, list items and escaped names, and nothing inherited', () => {
    const data = { from: { address: 'a@b.c' }, to: [{ address: 'x@y.z' }], 'a/b': { '~': 5 }, verified: false };
    expect(pointerValue(data, '/from/address')).toBe('a@b.c');
    expect(pointerValue(data, '/to/0/address')).toBe('x@y.z');
    expect(pointerValue(data, '/a~1b/~0')).toBe(5);
    expect(pointerValue(data, '/verified')).toBe(false);
    for (const missing of ['/nope', '/from/address/x', '/to/1', '/to/01', '/to/-', '/constructor', '/from/toString', '/__proto__']) expect(pointerValue(data, missing)).toBeUndefined();
  });

  test('the sender is a non-empty string, and verified is true only for a real true', () => {
    const pointers = { id: '/from/address', verified: '/ok' };
    expect(eventSenderOf(null, { from: { address: 'a@b.c' } })).toBeNull();
    expect(eventSenderOf({ id: '/from/address' }, { from: { address: ' a@b.c ' } })).toEqual({ id: 'a@b.c' });
    expect(eventSenderOf(pointers, { from: { address: 'a@b.c' }, ok: true })).toEqual({ id: 'a@b.c', verified: true });
    for (const ok of [false, 'true', 1, null, undefined]) expect(eventSenderOf(pointers, { from: { address: 'a@b.c' }, ok })).toEqual({ id: 'a@b.c', verified: false });
    for (const address of ['', '  ', 5, ['a@b.c'], { x: 1 }, 'x'.repeat(321)]) expect(eventSenderOf(pointers, { from: { address }, ok: true })).toEqual({ id: null, verified: true });
  });

  test('subscribe and unsubscribe carry the name, empty arguments and the address', () => {
    expect(subscribeParams('email.received', 'https://mcp.metro.box/v1/events/abc', 'whsec_x', null, 1000)).toEqual({ name: 'email.received', arguments: {}, delivery: { mode: 'webhook', url: 'https://mcp.metro.box/v1/events/abc', secret: 'whsec_x' }, cursor: null, ttlMs: 1000 });
    expect(unsubscribeParams('email.received', 'https://mcp.metro.box/v1/events/abc')).toEqual({ name: 'email.received', arguments: {}, delivery: { url: 'https://mcp.metro.box/v1/events/abc' } });
  });

  test('a subscribe answer needs an id and a time to refresh by; resultType is not required', () => {
    expect(subscribeResultOf({ id: 'sub_1', refreshBefore: '2026-11-11T10:00:00Z', cursor: 'c1', truncated: false })).toEqual({ id: 'sub_1', refreshBefore: Date.parse('2026-11-11T10:00:00Z'), cursor: 'c1', truncated: false, suspended: false, lastError: null });
    expect(subscribeResultOf({ resultType: 'complete', id: 'sub_1', refreshBefore: null, truncated: true, deliveryStatus: { active: false, lastError: 'http_5xx' } })).toEqual({ id: 'sub_1', refreshBefore: null, cursor: null, truncated: true, suspended: true, lastError: 'http_5xx' });
    expect(subscribeResultOf({ id: 'sub_1', refreshBefore: null, deliveryStatus: { active: true, lastError: 'HTTP/1.1 500 secret body' } }).lastError).toBeNull();
    for (const bad of [{}, { id: '', refreshBefore: null }, { id: 'has space', refreshBefore: null }, { id: 'x'.repeat(129), refreshBefore: null }, { id: 'sub_1' }, { id: 'sub_1', refreshBefore: 'soon' }, { id: 'sub_1', refreshBefore: 5 }, { id: 'sub_1', refreshBefore: null, cursor: 'x'.repeat(CURSOR_MAX + 1) }])
      expect(() => subscribeResultOf(bad)).toThrow();
  });

  test('a webhook body is an event unless it has a type, and an unusable one is null', () => {
    const at = '2026-11-10T10:00:00.000Z';
    expect(webhookBodyOf({ eventId: 'e1', name: 'email.received', timestamp: '2026-11-10T11:00:00+01:00', data: { a: 1 }, cursor: 'c1' })).toEqual({ kind: 'event', eventId: 'e1', name: 'email.received', timestamp: at, data: { a: 1 }, cursor: 'c1' });
    expect(webhookBodyOf({ eventId: 'e1', name: 'email.received', timestamp: at, data: {} })).toMatchObject({ kind: 'event', cursor: null });
    expect(webhookBodyOf({ type: 'verification', challenge: 'n1' })).toEqual({ kind: 'verification', challenge: 'n1' });
    expect(webhookBodyOf({ type: 'gap', cursor: 'fresh' })).toEqual({ kind: 'gap', cursor: 'fresh' });
    expect(webhookBodyOf({ type: 'terminated', error: { code: -32024, message: 'Forbidden', data: { reason: 'signed_out' } } })).toEqual({ kind: 'terminated', code: -32024, message: 'Forbidden', reason: 'signed_out' });
    expect(webhookBodyOf({ type: 'terminated', error: { code: -32023, message: 'x'.repeat(999), data: { reason: 'Access revoked!' } } })).toMatchObject({ code: -32023, reason: null });
    for (const bad of [null, [], 'x', {}, { type: 'verification' }, { type: 'terminated' }, { type: 'terminated', error: { code: 'x' } }, { type: 'new' }, { type: 5, eventId: 'e', name: 'a.b', timestamp: at, data: {} }, { eventId: '', name: 'a.b', timestamp: at, data: {} }, { eventId: 'x'.repeat(513), name: 'a.b', timestamp: at, data: {} }, { eventId: 'e', name: 'bad name', timestamp: at, data: {} }, { eventId: 'e', name: 'a.b', timestamp: 'never', data: {} }, { eventId: 'e', name: 'a.b', timestamp: at, data: [] }, { eventId: 'e', name: 'a.b', timestamp: at }])
      expect(webhookBodyOf(bad)).toBeNull();
  });
});

describe('who can write', () => {
  test('the list is normalized like a channel allowlist', () => {
    expect(normalizeSenderList([' Boss@Example.com ', 'boss@example.com', '@Example.COM', ''])).toEqual(['Boss@Example.com', '@example.com']);
    expect(normalizeSenderList(['a@b.c', '*'])).toEqual(['*']);
    expect(normalizeSenderList([])).toEqual(['*']);
    for (const bad of ['x', [5], ['@'], ['@nodot'], ['@bad domain.com'], ['x'.repeat(201)], ['a\nb'], Array.from({ length: 501 }, (_unused, at) => `p${String(at)}@x.y`)]) expect(() => normalizeSenderList(bad)).toThrow();
    expect(senderListOf('["a@b.c"]')).toEqual(['a@b.c']);
    for (const stored of [null, '[]', '["a@b.c","*"]']) expect(senderListOf(stored)).toEqual(['*']);
    for (const stored of ['', 'nope', '{}', '[5]']) {
      expect(senderListOf(stored)).toBeNull();
      expect(senderVerdict(senderListOf(stored), { id: 'a@b.c', verified: true })).toBe('not_listed');
    }
  });

  test('the verdict: listed and not forged, or anyone', () => {
    expect(senderVerdict(['*'], null)).toBe('allow');
    expect(senderVerdict(['*'], { id: 'x@y.z', verified: false })).toBe('allow');
    expect(senderVerdict(['a@b.c'], null)).toBe('not_listed');
    expect(senderVerdict(['a@b.c'], { id: null })).toBe('not_listed');
    expect(senderVerdict(['a@b.c'], { id: 'A@B.C' })).toBe('allow');
    expect(senderVerdict(['a@b.c'], { id: 'A@B.C', verified: true })).toBe('allow');
    expect(senderVerdict(['a@b.c'], { id: 'a@b.c', verified: false })).toBe('not_verified');
    expect(senderVerdict(['a@b.c'], { id: 'z@b.c', verified: false })).toBe('not_listed');
    expect(senderVerdict(['@b.c'], { id: 'anyone@b.c' })).toBe('allow');
    expect(senderVerdict(['@b.c'], { id: 'anyone@mail.b.c' })).toBe('not_listed');
    expect(senderVerdict(['@b.c'], { id: 'b.c' })).toBe('not_listed');
    expect(senderVerdict(['U123'], { id: 'u123' })).toBe('allow');
  });
});

describe('the inbox between mcp.metro.box and a box', () => {
  test('settled entries are read strictly', () => {
    expect(mcpSettledOf({})).toEqual([]);
    expect(mcpSettledOf({ settled: [{ id: 'abcdefghijk', outcome: 'delivered' }, { id: 'abcdefghijl', outcome: 'paused', extra: 1 }] })).toEqual([{ id: 'abcdefghijk', outcome: 'delivered' }, { id: 'abcdefghijl', outcome: 'paused' }]);
    for (const bad of [null, { settled: {} }, { settled: [{ id: 'short', outcome: 'delivered' }] }, { settled: [{ id: 'abcdefghijk', outcome: 'dropped' }] }, { settled: Array.from({ length: 101 }, () => ({ id: 'abcdefghijk', outcome: 'delivered' })) }])
      expect(() => mcpSettledOf(bad)).toThrow();
  });

  test('events are read tolerantly: an unreadable one is left out, never thrown', () => {
    const base = { id: 'abcdefghijk', connector: { id: 'conn0000001', key: 'work-mail', name: 'Work mail' }, event: 'email.received', timestamp: '2026-11-10T10:00:00.000Z' };
    const event = { ...base, kind: 'event', eventId: 'm1', data: { subject: 'Hi' }, sender: 'a@b.c', senderVerified: true };
    expect(mcpInboxOf({ events: [event, { ...base, kind: 'gap' }] })).toEqual([event, { ...base, kind: 'gap' }]);
    expect(mcpInboxOf({ events: [{ ...event, sender: 5, senderVerified: 'yes' }] })[0]).toEqual({ ...base, kind: 'event', eventId: 'm1', data: { subject: 'Hi' } });
    expect(mcpInboxOf({ events: [{ ...event, connector: { ...base.connector, name: '' } }] })[0]?.connector.name).toBe('work-mail');
    for (const bad of [null, { ...event, id: 'short' }, { ...event, connector: { ...base.connector, key: 'Work Mail' } }, { ...event, event: 'bad name' }, { ...event, timestamp: 'never' }, { ...event, data: [] }, { ...event, eventId: '' }, { ...event, kind: 'other' }])
      expect(mcpInboxOf({ events: [bad] })).toEqual([]);
    expect(() => mcpInboxOf({ approvals: [] })).toThrow();
  });
});

describe('listing a server reads its events only when it declares the extension', () => {
  const answers = (declares: boolean, events: unknown): { fetch: typeof fetch; methods: string[]; headers: Record<string, string | null>[] } => {
    const methods: string[] = [];
    const headers: Record<string, string | null>[] = [];
    const fake = ((_url: unknown, init?: RequestInit) => {
      if (init?.method === 'DELETE') return Promise.resolve(new Response(null, { status: 204 }));
      const message = JSON.parse(String(init?.body)) as { id?: number; method: string };
      methods.push(message.method);
      const sent = new Headers(init?.headers);
      headers.push({ method: sent.get('mcp-method'), name: sent.get('mcp-name') });
      const result = message.method === 'initialize' ? { protocolVersion: '2025-11-25', capabilities: declares ? { extensions: { [EVENTS_EXTENSION]: {} } } : { events: {} }, serverInfo: { name: 'x' } } : message.method === 'tools/list' ? { tools: [] } : events;
      if (message.method === 'notifications/initialized') return Promise.resolve(new Response(null, { status: 202 }));
      return Promise.resolve(Response.json(result === undefined ? { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } } : { jsonrpc: '2.0', id: message.id, result }));
    }) as typeof fetch;
    return { fetch: fake, methods, headers };
  };
  const url = new URL('https://vendor.example.com/mcp');

  test('descriptors keep name, title, description, delivery and the sender pointers', async () => {
    const listed = [
      { name: 'email.received', description: 'New mail.', delivery: ['webhook'], inputSchema: {}, _meta: { 'box.metro/sender': { id: '/from/address', verified: '/senderVerified' } } },
      { name: 'page.updated', title: 'Page changed', description: 'Edited.', delivery: ['poll', 'webhook', 5] },
      { name: 'bad name', delivery: ['webhook'] },
      { name: 'no.delivery', delivery: [] },
      { name: 'email.received', description: 'Twice.', delivery: ['webhook'] },
    ];
    const server = answers(true, { resultType: 'complete', events: listed });
    const read = await listRemoteServer(url, { kind: 'none' }, server.fetch);
    expect(read.events).toEqual([
      { name: 'email.received', title: 'Email received', description: 'New mail.', delivery: ['webhook'], sender: { id: '/from/address', verified: '/senderVerified' } },
      { name: 'page.updated', title: 'Page changed', description: 'Edited.', delivery: ['poll', 'webhook'] },
    ]);
    expect(server.methods).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'events/list']);
    expect(server.headers.at(-1)).toEqual({ method: 'events/list', name: null });
  });

  test('a server that does not declare it is never asked, and a failed list keeps what was known', async () => {
    const silent = answers(false, { events: [{ name: 'a.b', delivery: ['webhook'] }] });
    expect((await listRemoteServer(url, { kind: 'none' }, silent.fetch)).events).toEqual([]);
    expect(silent.methods).not.toContain('events/list');
    const broken = answers(true, undefined);
    expect((await listRemoteServer(url, { kind: 'none' }, broken.fetch)).events).toBeNull();
  });
});
