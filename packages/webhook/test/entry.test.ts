import { describe, expect, test } from 'bun:test';
import { webhookEntry } from '../src/station.ts';

const SECRET = 'shhh-very-secret';

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
      '/api/webhooks/gh1',
    );
    expect(e.station).toBe('webhook');
    expect(e.messageId).toBe('d-1');
    expect(e.text).toContain('push');
    expect((e.payload as { body: unknown }).body).toEqual({
      ref: 'refs/heads/main',
    });
  });

  test('without a bound session, `to` stays the webhook line', () => {
    const e = webhookEntry(endpoint, {}, {}, 'POST', '/api/webhooks/gh1');
    expect(e.to).toBe(e.line);
  });
});
