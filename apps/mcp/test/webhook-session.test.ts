/**
 * webhook -> session attribution. The binding is fully ADDITIVE: an endpoint
 * with no `session` mints exactly today's event (parity), while a bound endpoint
 * attributes its event `to` = metro://session/<id>.
 */

import { describe, expect, test } from 'bun:test';
import { webhookEntry } from '@metro-labs/webhook';
import { Line, asLine } from '../src/lines.ts';
import type { Endpoint } from '../src/tunnel.ts';

const sessionOwner = (id: string): Line => asLine(`metro://session/${id}`);

const ep = (over: Partial<Endpoint> = {}): Endpoint => ({
  id: 'abc123', label: 'gh', createdAt: '2026-06-10T00:00:00.000Z', ...over,
});
const headers = { 'x-github-event': 'push', 'x-github-delivery': 'd-1' };

describe('webhook -> session attribution (additive)', () => {
  test('NO binding => today behavior: to === webhook line, no session field', () => {
    const e = webhookEntry(ep(), headers, { a: 1 }, 'POST', '/wh/abc123');
    const line = Line.webhook('abc123');
    expect(e.to).toBe(line);
    expect(e.from).toBe(line);
    expect(e.line).toBe(line);
    expect(e.station).toBe('webhook');
    expect(e.lineName).toBe('gh');
    expect(e.messageId).toBe('d-1');
    expect(e.text).toBe('push POST /wh/abc123');
    expect(e.payload).toEqual({ headers, body: { a: 1 } });
  });

  test('bound endpoint => to = session owner; line/from stay the webhook line', () => {
    const e = webhookEntry(ep({ session: 'me' }), headers, {}, 'POST', '/wh/abc123');
    expect(e.to).toBe(sessionOwner('me'));
    expect(e.line).toBe(Line.webhook('abc123'));
    expect(e.from).toBe(Line.webhook('abc123'));
  });
});
