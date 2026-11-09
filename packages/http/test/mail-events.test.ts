import { describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { mailSenderVerdict, normalizeMailSenders, sendersOf } from '../src/mail-senders.ts';
import { declaresEvents, deliversMail, emailReceivedOf, eventsPageOf, MAIL_TEXT_MAX, subscribeAnswerOf, webhookBodyOf } from '../src/mcp-events.ts';
import { mailTakenOf, mcpMailOf } from '../src/mcp-server-protocol.ts';
import { checkWebhook, isWebhookSecret, newWebhookSecret, webhookHeadersOf, webhookSignature } from '../src/standard-webhooks.ts';

const SECRET = `whsec_${Buffer.alloc(32, 1).toString('base64')}`;
const NOW = Date.parse('2026-11-09T09:00:00.000Z');
const STAMP = String(NOW / 1000);

describe('Standard Webhooks signatures', () => {
  test('a new secret is whsec_ and 32 random bytes; other shapes are refused', () => {
    expect(isWebhookSecret(newWebhookSecret())).toBe(true);
    expect(newWebhookSecret()).not.toBe(newWebhookSecret());
    expect(isWebhookSecret(`whsec_${Buffer.alloc(23).toString('base64')}`)).toBe(false);
    expect(isWebhookSecret(`whsec_${Buffer.alloc(65).toString('base64')}`)).toBe(false);
    expect(isWebhookSecret('sk_live_abc')).toBe(false);
  });

  test('the signature is base64 HMAC-SHA256 of id.timestamp.body with the decoded secret', () => {
    const expected = createHmac('sha256', Buffer.alloc(32, 1)).update(`evt_1.${STAMP}.{"a":1}`).digest('base64');
    expect(webhookSignature(SECRET, 'evt_1', STAMP, '{"a":1}')).toBe(`v1,${expected}`);
  });

  test('a delivery verifies with any of its signatures, within 5 minutes, over the raw bytes only', () => {
    const body = Buffer.from('{"a":1}');
    const good = webhookSignature(SECRET, 'evt_1', STAMP, body);
    const headers = { id: 'evt_1', timestamp: STAMP, signature: `v1,AAAA ${good}`, subscription: null };
    expect(checkWebhook(SECRET, headers, body, NOW)).toBe('ok');
    expect(checkWebhook(SECRET, headers, Buffer.from('{"a": 1}'), NOW)).toBe('invalid');
    expect(checkWebhook(SECRET, { ...headers, id: 'evt_2' }, body, NOW)).toBe('invalid');
    expect(checkWebhook(SECRET, headers, body, NOW + 5 * 60_000 + 1000)).toBe('stale');
    expect(checkWebhook(SECRET, { ...headers, timestamp: 'soon' }, body, NOW)).toBe('invalid');
    expect(checkWebhook(newWebhookSecret(), headers, body, NOW)).toBe('invalid');
  });

  test('the headers are read only when all three are there', () => {
    expect(webhookHeadersOf({ 'webhook-id': 'a', 'webhook-timestamp': '1', 'webhook-signature': 'v1,x', 'x-mcp-subscription-id': 'sub_1' })).toEqual({ id: 'a', timestamp: '1', signature: 'v1,x', subscription: 'sub_1' });
    expect(webhookHeadersOf({ 'webhook-id': 'a', 'webhook-signature': 'v1,x' })).toBeNull();
  });
});

describe('the Events extension wire', () => {
  test('events are declared at the top level or under experimental', () => {
    expect(declaresEvents({ capabilities: { events: {} } })).toBe(true);
    expect(declaresEvents({ capabilities: { experimental: { events: { listChanged: true } } } })).toBe(true);
    expect(declaresEvents({ capabilities: { tools: {} } })).toBe(false);
  });

  test('events/list keeps named events and their delivery modes', () => {
    const page = eventsPageOf({ events: [{ name: 'email.received', delivery: ['webhook', 'carrier-pigeon'] }, { name: '' }, { name: 'x.y', delivery: ['poll'] }], nextCursor: 'p2' });
    expect(page).toEqual({ events: [{ name: 'email.received', delivery: ['webhook'] }, { name: 'x.y', delivery: ['poll'] }], next: 'p2' });
    expect(deliversMail(page.events)).toBe(true);
    expect(deliversMail([{ name: 'email.received', delivery: ['poll'] }])).toBe(false);
  });

  test('a subscribe answer needs an id and a refreshBefore time or null', () => {
    expect(subscribeAnswerOf({ id: 'sub_1', refreshBefore: '2026-11-10T09:00:00Z', cursor: 'h1', truncated: true })).toEqual({ id: 'sub_1', refreshBefore: Date.parse('2026-11-10T09:00:00Z'), cursor: 'h1', truncated: true, delivering: true, lastError: null });
    expect(subscribeAnswerOf({ id: 'sub_1', refreshBefore: null, deliveryStatus: { active: false, lastError: 'http_5xx' } })).toEqual({ id: 'sub_1', refreshBefore: null, cursor: null, truncated: false, delivering: false, lastError: 'http_5xx' });
    expect(() => subscribeAnswerOf({ id: 'sub_1' })).toThrow();
    expect(() => subscribeAnswerOf({ refreshBefore: null })).toThrow();
  });

  test('a body is an event or one of the control envelopes', () => {
    expect(webhookBodyOf({ eventId: 'e1', name: 'email.received', data: { a: 1 }, cursor: 'c1' })).toEqual({ type: 'event', eventId: 'e1', name: 'email.received', data: { a: 1 }, cursor: 'c1' });
    expect(webhookBodyOf({ type: 'verification', challenge: 'n1' })).toEqual({ type: 'verification', challenge: 'n1' });
    expect(webhookBodyOf({ type: 'gap', cursor: 'c2' })).toEqual({ type: 'gap', cursor: 'c2' });
    expect(webhookBodyOf({ type: 'terminated', error: { code: -32024, message: 'signed out', data: { reason: 'signed_out' } } })).toEqual({ type: 'terminated', reason: 'signed out', signedOut: true });
    expect(webhookBodyOf({ type: 'terminated', error: { code: -32023, message: 'gone' } })).toEqual({ type: 'terminated', reason: 'gone', signedOut: false });
    expect(webhookBodyOf({ type: 'something-new' })).toEqual({ type: 'other' });
    expect(webhookBodyOf({ name: 'email.received' })).toBeNull();
  });

  test('a mail keeps only what it may: lowercased addresses, https links, 32 KB of text', () => {
    const mail = emailReceivedOf({
      messageId: 'm1', threadId: 't1', from: { address: ' Lisa@Anderra.CH ', name: 'Lisa\u0000 Rossi' }, to: ['A@B.com', 'not-an-address'], cc: [],
      subject: 'Hi\r\nthere', receivedAt: 'yesterday', text: 'x'.repeat(MAIL_TEXT_MAX + 10), senderVerified: 'yes',
      attachments: [{ name: 'a.pdf', mime: 'application/pdf', size: 10, url: 'https://files.example.com/a' }, { name: 'b', url: 'http://files.example.com/b' }, { url: 'https://user:pass@files.example.com/c' }],
    });
    expect(mail).toMatchObject({ from: { address: 'lisa@anderra.ch', name: 'Lisa  Rossi' }, to: ['a@b.com'], subject: 'Hi there', senderVerified: false });
    expect(mail?.attachments).toEqual([
      { name: 'a.pdf', mime: 'application/pdf', size: 10, url: 'https://files.example.com/a' },
      { name: 'b', mime: 'application/octet-stream', size: 0, url: null },
      { name: 'attachment', mime: 'application/octet-stream', size: 0, url: null },
    ]);
    expect(mail?.text).toHaveLength(MAIL_TEXT_MAX);
    expect(emailReceivedOf({ messageId: 'm1', threadId: 't1', from: { address: 'a/b@c.com' } })).toBeNull();
    expect(emailReceivedOf({ threadId: 't1', from: { address: 'a@c.com' } })).toBeNull();
  });

  test('the box reads waiting mail and says which it took', () => {
    const row = { id: 'inbox000001', connector: 'conn0000001', key: 'gmail', name: 'Gmail', messageId: 'm1', threadId: 't1', from: { address: 'a@b.com' } };
    expect(mcpMailOf({ mail: [row, { ...row, id: 'bad' }, { ...row, key: 'Not A Key' }] }).map((mail) => mail.id)).toEqual(['inbox000001']);
    expect(mcpMailOf({ approvals: [] })).toEqual([]);
    expect(mailTakenOf({ taken: [{ id: 'inbox000001', outcome: 'paused' }] })).toEqual([{ id: 'inbox000001', outcome: 'paused' }]);
    expect(() => mailTakenOf({ taken: [] })).toThrow();
    expect(() => mailTakenOf({ taken: [{ id: 'inbox000001', outcome: 'read' }] })).toThrow();
  });
});

describe('who can write to an agent by mail', () => {
  test('the list is addresses and @domains in lowercase, and * means anyone', () => {
    expect(normalizeMailSenders([' Lisa@Anderra.ch', '@MCIGROUP.ch', 'lisa@anderra.ch'])).toEqual(['lisa@anderra.ch', '@mcigroup.ch']);
    expect(normalizeMailSenders([])).toEqual(['*']);
    expect(normalizeMailSenders(['a@b.com', '*'])).toEqual(['*']);
    expect(() => normalizeMailSenders(['Lisa'])).toThrow('is not an email address or a domain');
    expect(() => normalizeMailSenders(['@'])).toThrow();
    expect(() => normalizeMailSenders('a@b.com')).toThrow();
    expect(sendersOf(null)).toEqual(['*']);
    expect(sendersOf('not json')).toEqual([]);
  });

  test('a sender passes by address or exact domain, and must be verified unless anyone may write', () => {
    expect(mailSenderVerdict(['*'], 'x@y.com', false)).toBe('ok');
    expect(mailSenderVerdict(['@anderra.ch'], 'Lisa@Anderra.ch', true)).toBe('ok');
    expect(mailSenderVerdict(['@anderra.ch'], 'lisa@mail.anderra.ch', true)).toBe('sender');
    expect(mailSenderVerdict(['lisa@anderra.ch'], 'lisa@anderra.ch', false)).toBe('unverified');
    expect(mailSenderVerdict(['lisa@anderra.ch'], 'bob@anderra.ch', false)).toBe('sender');
    expect(mailSenderVerdict([], 'lisa@anderra.ch', true)).toBe('sender');
  });
});
