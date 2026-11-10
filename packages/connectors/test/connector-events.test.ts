import { describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { publicEvents } from '../src/catalogue.ts';
import { eventNamesOf } from '../src/db/connector-subscriptions.ts';
import type { ConnectorSecret } from '../src/model.ts';
import { openSecret, sealSecret } from '../src/secrets.ts';

const OWNER = 'org_01TESTOWNER000000';
const SECRET: ConnectorSecret = { kind: 'header', targetUrl: 'https://vendor.example.com/v1/PATH_SECRET/mcp?key=QUERY_SECRET', name: 'Authorization', value: 'Bearer HEADER_SECRET' };

describe('sealing domains', () => {
  test('a webhook secret, a waiting event and a connector secret never open as one another', () => {
    const key = randomBytes(32);
    const webhook = sealSecret(key, OWNER, 'row00000001', 'whsec_x', 'webhook');
    const event = sealSecret(key, OWNER, 'row00000001', { data: { text: 'hello' } }, 'event');
    expect(openSecret(key, OWNER, 'row00000001', webhook, 'webhook')).toBe('whsec_x');
    expect(openSecret(key, OWNER, 'row00000001', event, 'event')).toEqual({ data: { text: 'hello' } });
    for (const [sealed, purpose] of [[webhook, 'event'], [webhook, 'connector'], [webhook, 'model'], [event, 'webhook'], [event, 'connector']] as const)
      expect(() => openSecret(key, OWNER, 'row00000001', sealed, purpose)).toThrow('could not be opened');
    expect(() => openSecret(key, OWNER, 'row00000002', event, 'event')).toThrow('could not be opened');
    expect(() => openSecret(key, 'org_01TESTSTRANGER00', 'row00000001', event, 'event')).toThrow('could not be opened');
  });

  test('a waiting event may be as large as a delivery, a connector secret may not', () => {
    const key = randomBytes(32);
    const large = { text: 'x'.repeat(300 * 1024) };
    expect(() => sealSecret(key, OWNER, 'row00000001', large, 'event')).not.toThrow();
    expect(() => sealSecret(key, OWNER, 'row00000001', large, 'connector')).toThrow('too large');
    expect(() => sealSecret(key, OWNER, 'row00000001', { text: 'x'.repeat(600 * 1024) }, 'event')).toThrow('too large');
  });
});

describe('event descriptors are redacted like tools', () => {
  const event = { name: 'email.received', title: 'Email received', description: 'Sent to https://internal.example/hook with HEADER_SECRET', delivery: ['webhook'], sender: { id: '/from/address' } };

  test('addresses and credentials leave the words, and a name holding one drops the descriptor', () => {
    expect(publicEvents([event, { ...event, name: 'PATH_SECRET.changed' }], SECRET)).toEqual([{ ...event, description: 'Sent to [address withheld] with [redacted]' }]);
    expect(publicEvents([], SECRET)).toEqual([]);
  });

  test('a list that could not be read stays unknown', () => {
    expect(publicEvents(null, SECRET)).toBeNull();
  });
});

describe('the event names an assignment wants', () => {
  test('are read tolerantly from the stored JSON', () => {
    expect(eventNamesOf('["email.received","page.updated","email.received"]')).toEqual(['email.received', 'page.updated']);
    for (const stored of [null, '', 'nope', '{}', '[5]', '["bad name"]']) expect(eventNamesOf(stored)).toEqual([]);
  });
});
