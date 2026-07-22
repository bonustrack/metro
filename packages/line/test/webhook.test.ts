import { describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import {
  messageText,
  parseLineEvents,
  verifyLineSignature,
  type LineWebhookBody,
} from '../src/webhook.js';

const SECRET = 'test-channel-secret';

function sign(body: string): string {
  return createHmac('sha256', SECRET).update(Buffer.from(body)).digest('base64');
}

describe('verifyLineSignature', () => {
  test('accepts a valid base64 HMAC-SHA256 signature', () => {
    const body = JSON.stringify({ events: [] });
    const raw = Buffer.from(body);
    expect(verifyLineSignature(SECRET, raw, sign(body))).toBe(true);
  });

  test('rejects a wrong signature', () => {
    const raw = Buffer.from(JSON.stringify({ events: [] }));
    expect(verifyLineSignature(SECRET, raw, sign('tampered'))).toBe(false);
  });

  test('rejects a missing signature header', () => {
    const raw = Buffer.from('{}');
    expect(verifyLineSignature(SECRET, raw, undefined)).toBe(false);
  });

  test('rejects when the secret differs', () => {
    const body = JSON.stringify({ events: [] });
    const raw = Buffer.from(body);
    expect(verifyLineSignature('other-secret', raw, sign(body))).toBe(false);
  });
});

describe('messageText', () => {
  test('extracts text for text messages', () => {
    expect(messageText({ type: 'text', text: 'hello' })).toBe('hello');
  });

  test('never returns blank for text with empty string', () => {
    expect(messageText({ type: 'text', text: '' })).toBe('[unsupported message]');
  });

  test('placeholders media types', () => {
    expect(messageText({ type: 'sticker' })).toBe('[sticker]');
    expect(messageText({ type: 'image' })).toBe('[image]');
    expect(messageText({ type: 'location' })).toBe('[location]');
  });

  test('placeholders unknown types', () => {
    expect(messageText({ type: 'flex' })).toBe('[unsupported message]');
  });
});

describe('parseLineEvents', () => {
  const uid = 'U'.padEnd(33, '0');
  const gid = 'C'.padEnd(33, '1');

  test('maps a 1:1 text message to an inbound event', () => {
    const body: LineWebhookBody = {
      events: [
        {
          type: 'message',
          timestamp: 1700000000000,
          source: { type: 'user', userId: uid },
          message: { id: '42', type: 'text', text: 'hi' },
        },
      ],
    };
    const out = parseLineEvents('l0', body);
    expect(out).toHaveLength(1);
    const e = out[0]!;
    expect(e.station).toBe('line');
    expect(e.line).toBe(`metro://line/l0/${uid}`);
    expect(e.from).toBe(`metro://line/l0/user/${uid}`);
    expect(e.text).toBe('hi');
    expect(e.messageId).toBe('42');
  });

  test('routes a group message line to the group id, sender to the user', () => {
    const body: LineWebhookBody = {
      events: [
        {
          type: 'message',
          source: { type: 'group', groupId: gid, userId: uid },
          message: { id: '7', type: 'text', text: 'yo' },
        },
      ],
    };
    const e = parseLineEvents('l0', body)[0]!;
    expect(e.line).toBe(`metro://line/l0/${gid}`);
    expect(e.from).toBe(`metro://line/l0/user/${uid}`);
  });

  test('emits a placeholder (never blank) for stickers', () => {
    const body: LineWebhookBody = {
      events: [
        {
          type: 'message',
          source: { type: 'user', userId: uid },
          message: { id: '9', type: 'sticker' },
        },
      ],
    };
    expect(parseLineEvents('l0', body)[0]!.text).toBe('[sticker]');
  });

  test('ignores non-message events and events without message id', () => {
    const body: LineWebhookBody = {
      events: [
        { type: 'follow', source: { type: 'user', userId: uid } },
        {
          type: 'message',
          source: { type: 'user', userId: uid },
          message: { type: 'text', text: 'no id' },
        },
      ],
    };
    expect(parseLineEvents('l0', body)).toHaveLength(0);
  });
});
