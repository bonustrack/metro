import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { publishEvent, userSelf, type MetroEvent, type RunEventsPage } from '@metro-labs/core/events';
import { asLine } from '@metro-labs/core/lines';
import { setBearerSessions } from '@metro-labs/http/api-http';
import { SigningKeys } from '@metro-labs/http/workos-token';
import { setAgentMap, setAllowlistMap, setDisabledAccounts } from '../src/agents/map.js';
import { setKeyMap } from '../src/agents/keys.js';
import { bearerSessionsFor } from '../src/routes/bearer.js';
import { fakeIssuer, sessionClaims, type FakeIssuer } from '../../../packages/http/test/workos-fixture.js';
import { bootDaemon, type Daemon } from './http-harness.js';

const AGENT = 'agent000001';
const OTHER = 'agent000002';
const ORG = 'org_01RUNEVENTS000000';
const LINE = asLine('metro://whatsapp/own/chat');
const FROM = asLine('metro://whatsapp/own/user/alice');
let owner: string | null = ORG;
let daemon: Daemon;
let issuer: FakeIssuer;

const event = (fields: Partial<MetroEvent> = {}): MetroEvent => ({
  id: randomUUID(), ts: '2026-10-05T19:00:00.000Z', station: 'whatsapp', line: LINE,
  from: FROM, to: userSelf(), fromName: 'Alice', text: 'Hello', event: { type: 'msg' }, ...fields,
});
const emit = (fields: Partial<MetroEvent> = {}): MetroEvent => {
  const next = event(fields);
  publishEvent(next);
  return next;
};
const bearer = (claims: Record<string, unknown> = {}): string => `Bearer ${issuer.mint(sessionClaims({ org_id: ORG, role: 'member', ...claims }))}`;
const get = (query = '', authorization = bearer()): Promise<Response> => fetch(`${daemon.base}/api/run/events?agent=${AGENT}${query}`, { headers: { authorization } });
const page = async (query = ''): Promise<RunEventsPage> => {
  const response = await get(query);
  expect(response.status).toBe(200);
  return response.json() as Promise<RunEventsPage>;
};

beforeAll(async () => {
  issuer = await fakeIssuer();
  setBearerSessions(bearerSessionsFor(() => owner, new SigningKeys(issuer.url)));
  daemon = await bootDaemon({}, { monitor: true });
});

beforeEach(() => {
  owner = ORG;
  setAgentMap({ 'whatsapp/own': AGENT, 'whatsapp/other': OTHER }, { [AGENT]: 'Same name', [OTHER]: 'Same name' });
  setAllowlistMap({});
  setDisabledAccounts(new Set());
  setKeyMap([{ agentId: AGENT, key: 'mk-run-events-secret' }]);
  for (let i = 0; i < 500; i += 1) emit({ line: asLine('invalid') });
});

afterAll(async () => {
  setAgentMap({}, {});
  setAllowlistMap({});
  setDisabledAccounts(new Set());
  setKeyMap([]);
  setBearerSessions(null);
  await daemon.close();
  await issuer.close();
});

describe('browser Run events', () => {
  test('uses the centralized owner bearer gate before monitor, never an agent key or query credential', async () => {
    for (const authorization of ['', 'Bearer mk-run-events-secret', 'Bearer garbage', bearer({ exp: 1 })]) {
      const response = await get('', authorization);
      expect(response.status).toBe(401);
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
    expect((await get('', bearer({ org_id: 'org_OTHER' }))).status).toBe(403);
    expect((await get('', bearer({ org_id: undefined }))).status).toBe(403);
    expect((await get('&token=mk-run-events-secret', '')).status).toBe(401);
    expect((await fetch(`${daemon.base}/api/run/events?agent=${AGENT}`, { headers: { cookie: `token=${bearer()}` } })).status).toBe(401);
    for (const role of ['admin', 'member']) {
      const response = await get('', bearer({ role }));
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
    setKeyMap([]);
    expect((await get()).status).toBe(200);
    owner = 'org_CHANGED';
    expect((await get()).status).toBe(403);
    owner = null;
    expect((await get()).status).toBe(403);
  });

  test('is read only, accepts preflight and rejects invalid bounds, duplicate params and unknown IDs', async () => {
    const options = await fetch(`${daemon.base}/api/run/events`, { method: 'OPTIONS', headers: { origin: 'https://metro.box' } });
    expect(options.status).toBe(204);
    expect(options.headers.get('access-control-allow-origin')).toBe('https://metro.box');
    for (const method of ['POST', 'PUT', 'DELETE', 'HEAD']) expect((await fetch(`${daemon.base}/api/run/events`, { method })).status).toBe(405);
    for (const query of ['&limit=0', '&limit=-1', '&limit=501', '&limit=1.5', '&limit=NaN', '&limit=', '&limit=1e2', '&cursor=', '&cursor=bad', '&cursor=' + 'x'.repeat(10_000), '&limit=2&limit=3', '&agent=agent000002', '&secret=bad']) expect((await get(query)).status).toBe(400);
    expect((await fetch(`${daemon.base}/api/run/events`, { headers: { authorization: bearer() } })).status).toBe(400);
    expect((await fetch(`${daemon.base}/api/run/events?agent=Same%20name`, { headers: { authorization: bearer() } })).status).toBe(400);
    expect((await fetch(`${daemon.base}/api/run/events?agent=agent000099`, { headers: { authorization: bearer() } })).status).toBe(404);
  });

  test('preserves real sender, body, direction, IDs and safe metadata without train calls', async () => {
    const incoming = emit({ fromDisplayName: 'Alice Smith', lineName: 'Room', messageId: 'msg-1', replyTo: 'parent-1', isPrivate: true, senderVerified: true, mentionsSelf: true, replyToSelf: false, event: { type: 'reply', replyTo: 'parent-1' } });
    const outgoing = emit({ from: userSelf(), to: LINE, text: 'Reply', messageId: 'msg-2', agent: 'Wrong display name' });
    const result = await page();
    expect(result.events).toHaveLength(2);
    expect(result.events[0]).toMatchObject({ id: incoming.id, ts: incoming.ts, kind: 'reply', direction: 'inbound', agentId: AGENT, station: 'whatsapp', accountId: 'own', line: LINE, lineName: 'Room', from: FROM, fromName: 'Alice', fromDisplayName: 'Alice Smith', text: 'Hello', messageId: 'msg-1', replyTo: 'parent-1', metadata: { isPrivate: true, senderVerified: true, mentionsSelf: true, replyToSelf: false }, truncated: false });
    expect(result.events[1]).toMatchObject({ id: outgoing.id, direction: 'outbound', agentId: AGENT, text: 'Reply' });
    expect(result.reset).toBe(true);
    expect(result.retention.capacity).toBe(500);
  });

  test('fails closed for malformed, unowned, cross-agent and mismatched private traffic', async () => {
    emit();
    for (const fields of [
      { line: asLine('not-a-line') }, { line: asLine('bad://whatsapp/own/chat') }, { line: asLine('metro://whatsapp//own/chat') },
      { line: asLine('metro://whatsapp/missing/chat') }, { line: asLine('metro://whatsapp/other/chat') },
      { station: 'telegram' }, { from: asLine('metro://whatsapp/other/user/alice'), isPrivate: true },
      { to: asLine('metro://whatsapp/other/chat'), isPrivate: true }, { from: asLine('metro://claude/other/session'), isPrivate: true },
      { line: asLine('metro://unknown/thing'), station: 'unknown', event: { type: 'system' as const } },
      { ts: 'bad time' }, { id: 'x'.repeat(513) },
    ]) emit(fields);
    expect((await page()).events).toHaveLength(1);
  });

  test('rechecks current allowlists and verified mail rules and resets when policy or ownership changes', async () => {
    const own = emit();
    emit({ from: asLine('metro://whatsapp/own/user/bob') });
    emit({ senderVerified: false });
    let previous = await page();
    expect(previous.events).toHaveLength(3);
    setAllowlistMap({ 'whatsapp/own': ['alice'] });
    let changed = await page(`&cursor=${previous.cursor}`);
    expect(changed.reset).toBe(true);
    expect(changed.events.map((row) => row.id)).toEqual([own.id]);
    const outgoing = emit({ from: userSelf(), to: LINE });
    expect((await page()).events.map((row) => row.id)).toEqual([own.id, outgoing.id]);
    previous = changed;
    setDisabledAccounts(new Set(['whatsapp/own']));
    changed = await page(`&cursor=${previous.cursor}`);
    expect(changed.reset).toBe(true);
    expect(changed.events).toEqual([]);
    setDisabledAccounts(new Set());
    previous = await page();
    setAgentMap({ 'whatsapp/own': OTHER }, { [AGENT]: 'Same name', [OTHER]: 'Same name' });
    changed = await page(`&cursor=${previous.cursor}`);
    expect(changed.reset).toBe(true);
    expect(changed.events).toEqual([]);
    setAgentMap({}, { [AGENT]: 'Same name' });
    expect((await page()).events).toEqual([]);
  });

  test('paginates forward without duplicates, defaults to recent rows and clears on expiration or restart', async () => {
    const baseline = await page();
    const entries = Array.from({ length: 5 }, (_, i) => emit({ text: `message ${i}` }));
    const first = await page(`&cursor=${baseline.cursor}&limit=2`);
    expect(first.reset).toBe(false);
    expect(first.hasMore).toBe(true);
    const second = await page(`&cursor=${first.cursor}&limit=2`);
    const third = await page(`&cursor=${second.cursor}&limit=2`);
    expect([...first.events, ...second.events, ...third.events].map((row) => row.id)).toEqual(entries.map((entry) => entry.id));
    expect(third.hasMore).toBe(false);
    expect((await page(`&cursor=${third.cursor}`)).events).toEqual([]);
    expect((await page('&limit=2')).events.map((row) => row.id)).toEqual(entries.slice(-2).map((entry) => entry.id));
    const restarted = '00000000-0000-0000-0000-000000000000' + third.cursor.slice(36);
    expect((await page(`&cursor=${restarted}`)).reset).toBe(true);
    const ahead = third.cursor.slice(0, third.cursor.lastIndexOf(':') + 1) + '9007199254740991';
    expect((await page(`&cursor=${ahead}`)).reset).toBe(true);
    for (let i = 0; i < 501; i += 1) emit({ text: String(i) });
    const expired = await page(`&cursor=${third.cursor}&limit=500`);
    expect(expired.reset).toBe(true);
    expect(expired.events).toHaveLength(500);
    expect(expired.events[0]?.text).toBe('1');
    expect(expired.retention.oldestSeq).toBe(expired.events[0]?.seq ?? null);
    expect(expired.events.some((row) => entries.some((entry) => row.id === entry.id))).toBe(false);
  });

  test('bounds text, metadata and encoded page size while still draining all rows', async () => {
    const initial = await page();
    for (let i = 0; i < 100; i += 1) emit({ text: '\u0001'.repeat(20_000), fromName: 'n'.repeat(100_000), payload: { attachments: Array.from({ length: 1000 }, () => ({ kind: 'image', url: 'SECRET' })) } });
    let result = await page(`&cursor=${initial.cursor}&limit=500`);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(1_001_000);
    expect(result.hasMore).toBe(true);
    expect(result.events[0]?.text).toHaveLength(8_000);
    expect(result.events[0]?.fromName).toHaveLength(512);
    expect(result.events[0]?.truncated).toBe(true);
    expect(result.events[0]?.metadata).toEqual({ attachmentCount: 1000, attachmentTypes: ['image'] });
    let total = result.events.length;
    for (let i = 0; i < 10 && result.hasMore; i += 1) {
      result = await page(`&cursor=${result.cursor}&limit=500`);
      total += result.events.length;
    }
    expect(total).toBe(100);
    expect(result.hasMore).toBe(false);
  });

  test('keeps real reaction removal and attachment MIME facts', async () => {
    emit({ event: { type: 'react', emoji: 'x', targetId: 'target' }, payload: { removed: true } });
    emit({ payload: { attachments: [{ contentType: 'image/png' }, { contentType: 'video/mp4' }, { contentType: 'audio/ogg' }, { contentType: 'application/pdf' }] } });
    const result = await page();
    expect(result.events[0]?.metadata).toEqual({ emoji: 'x', targetId: 'target', removed: true });
    expect(result.events[1]?.metadata).toEqual({ attachmentCount: 4, attachmentTypes: ['image', 'video', 'audio', 'file'] });
  });

  test('bounds repeated URL-prefix bodies and empty cursor polls', async () => {
    const text = 'https://'.repeat(1000);
    for (let i = 0; i < 500; i += 1) emit({ text });
    const first = await page('&limit=500');
    expect(first.events[0]?.text).toBe(text);
    let result = first;
    for (let i = 0; i < 10 && result.hasMore; i += 1) result = await page(`&cursor=${result.cursor}&limit=500`);
    expect(result.hasMore).toBe(false);
    const last = await page(`&cursor=${result.cursor}`);
    expect(last.events).toEqual([]);
    expect(last.reset).toBe(false);
    expect(last.retention.oldestAt).toBe(first.retention.oldestAt);
  });

  test('never labels a synthetic transcript as outbound or bypasses current sender policy with its body', async () => {
    emit({ from: userSelf(), to: LINE, text: 'PRIVATE_TRANSCRIPT', payload: { contentType: 'transcript', transcribeFor: 'inbound-id', transcript: 'PRIVATE_TRANSCRIPT', attachmentPath: '/tmp/PRIVATE_PATH' } });
    emit({ from: userSelf(), to: LINE, text: '/tmp/PRIVATE_PATH', payload: { contentType: 'attachmentSaved', attachmentFor: 'inbound-id' } });
    const original = await page();
    expect(original.events).toHaveLength(2);
    expect(original.events.every((row) => row.kind === 'system' && row.direction === 'system' && row.text === undefined)).toBe(true);
    expect(JSON.stringify(original)).not.toContain('PRIVATE');
    setAllowlistMap({ 'whatsapp/own': ['alice'] });
    const filtered = await page(`&cursor=${original.cursor}`);
    expect(filtered.reset).toBe(true);
    expect(filtered.events).toEqual([]);
  });

  test('never coerces malformed opaque payload fields into strings', async () => {
    emit({ payload: { contentType: { toString: 'secret' }, attachments: [{ kind: { toString: 'secret' }, mime: { toString: 'secret' } }] } });
    const result = await page();
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.text).toBe('Hello');
    expect(result.events[0]?.metadata).toEqual({ attachmentCount: 1, attachmentTypes: ['file'] });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  test('excludes raw payload, credentials, capabilities and generated system body data', async () => {
    emit({ text: 'Read https://box/attach/file.pdf?token=CAPABILITY and https://example.com/docs', display: 'DISPLAY_SECRET', payload: { apiKey: 'KEY_SECRET', headers: { authorization: 'BEARER_SECRET' }, args: { password: 'ARG_SECRET' }, attachments: [{ kind: 'image', mime: 'image/png', url: 'ATTACHMENT_SECRET', name: 'FILENAME_SECRET', dataB64: 'BYTES_SECRET' }] } });
    emit({ text: '/tmp/PATH_SECRET', payload: { contentType: 'attachmentSaved', attachmentPath: '/tmp/PATH_SECRET', url: 'URL_SECRET', attachmentFor: 'message-1', mime: 'image/png', name: 'NAME_SECRET' } });
    emit({ event: { type: 'system', source: 'SOURCE_SECRET', eventName: 'EVENT_SECRET' }, text: 'SYSTEM_SECRET', lineName: 'SUBJECT_SECRET', payload: { error: 'ERROR_SECRET' } });
    emit({ station: 'claude', line: asLine('metro://claude/local/session'), event: { type: 'system' }, text: 'LOCAL_SECRET' });
    const result = await page();
    expect(result.events).toHaveLength(4);
    const wire = JSON.stringify(result);
    expect(wire).not.toContain('SECRET');
    expect(wire).not.toContain('CAPABILITY');
    expect(wire).not.toContain('?token=');
    expect(result.events[0]?.text).toBe('Read [private link] and https://example.com/docs');
    expect(result.events[1]).toMatchObject({ kind: 'system', direction: 'system', metadata: { attachmentCount: 1, attachmentTypes: ['image'], attachmentStatus: 'saved', attachmentFor: 'message-1' } });
    expect(result.events[2]?.text).toBeUndefined();
    expect(result.events[3]?.accountId).toBeNull();
  });
});
