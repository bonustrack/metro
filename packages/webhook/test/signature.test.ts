import { describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { verifyWebhookSig, webhookEntry } from '../src/station.ts';

const SECRET = 'shhh-very-secret';
const BODY = Buffer.from(JSON.stringify({ hello: 'world' }));

const sign = (secret: string, raw: Buffer): string =>
  'sha256=' + createHmac('sha256', secret).update(raw).digest('hex');

describe('verifyWebhookSig', () => {
  test('accepts a valid signature', () => {
    expect(verifyWebhookSig(SECRET, BODY, sign(SECRET, BODY))).toBe(true);
  });

  test('accepts a valid signature over an empty body', () => {
    const empty = Buffer.alloc(0);
    expect(verifyWebhookSig(SECRET, empty, sign(SECRET, empty))).toBe(true);
  });

  test('rejects a signature made with the wrong secret', () => {
    expect(verifyWebhookSig(SECRET, BODY, sign('other-secret', BODY))).toBe(
      false,
    );
  });

  test('rejects when the body was tampered with', () => {
    const sig = sign(SECRET, BODY);
    expect(verifyWebhookSig(SECRET, Buffer.from('tampered'), sig)).toBe(false);
  });

  test('rejects a missing header', () => {
    expect(verifyWebhookSig(SECRET, BODY, undefined)).toBe(false);
  });

  test('rejects a header without the sha256= prefix', () => {
    const bare = createHmac('sha256', SECRET).update(BODY).digest('hex');
    expect(verifyWebhookSig(SECRET, BODY, bare)).toBe(false);
  });

  test('rejects truncated/odd-length hex without throwing', () => {
    expect(verifyWebhookSig(SECRET, BODY, 'sha256=abc')).toBe(false);
  });

  test('rejects non-hex garbage without throwing', () => {
    expect(verifyWebhookSig(SECRET, BODY, 'sha256=zzzz')).toBe(false);
  });
});

describe('webhookEntry', () => {
  const endpoint = {
    id: 'gh1',
    label: 'GitHub',
    secret: SECRET,
    createdAt: '2026-01-01T00:00:00.000Z',
  };

  test('maps a github event onto a webhook MetroEvent', () => {
    const e = webhookEntry(
      endpoint,
      { 'x-github-event': 'push', 'x-github-delivery': 'd-1' },
      { ref: 'refs/heads/main' },
      'POST',
      '/wh/gh1',
    );
    expect(e.station).toBe('webhook');
    expect(e.messageId).toBe('d-1');
    expect(e.text).toContain('push');
    expect((e.payload as { body: unknown }).body).toEqual({
      ref: 'refs/heads/main',
    });
  });

  test('without a bound session, `to` stays the webhook line', () => {
    const e = webhookEntry(endpoint, {}, {}, 'POST', '/wh/gh1');
    expect(e.to).toBe(e.line);
  });
});
