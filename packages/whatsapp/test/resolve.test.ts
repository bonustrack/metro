import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { makeHandleCall } from '../src/actions.ts';
import { accounts } from '../src/accounts.ts';
import { phoneNumberOf, senderLookup, type SenderFound } from '../src/resolve.ts';
import type { WAClient } from '../src/client.ts';

const LID = '209876543210987@lid';
const PN = '41791234567@s.whatsapp.net';

function fakeClient(found: SenderFound, asked: string[]): WAClient {
  return {
    account: { id: 'w0', phone: '41791234567' },
    self: () => '41791234567',
    lookupSender: (number: string) => {
      asked.push(number);
      return Promise.resolve(found);
    },
  } as unknown as WAClient;
}

function captureResponses(): { responses: { result?: unknown; error?: string }[]; restore: () => void } {
  const responses: { result?: unknown; error?: string }[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    const parsed = JSON.parse(String(chunk)) as { op?: string; result?: unknown; error?: string };
    if (parsed.op === 'response') responses.push(parsed);
    return true;
  }) as typeof process.stdout.write;
  return { responses, restore: () => void (process.stdout.write = orig) };
}

describe('reading a phone number the way a person writes one', () => {
  test('every separator a person types survives, and the country code leads', () => {
    for (const written of [
      '+41 79 123 45 67',
      '+41791234567',
      '0041 79 123 45 67',
      '41791234567',
      '+41-79-123-45-67',
      '+41 (79) 123 45 67',
      '41791234567@s.whatsapp.net',
    ])
      expect(phoneNumberOf(written)).toBe('41791234567');
  });

  test('a national number is refused by name rather than guessed at', () => {
    const attempt = (): string => phoneNumberOf('079 123 45 67');
    expect(attempt).toThrow('national number');
    expect(attempt).toThrow('41791234567');
  });

  test('a sender id pasted into the lookup is sent to the Add field instead', () => {
    expect(() => phoneNumberOf(LID)).toThrow('already a sender id');
  });

  test('what is not a phone number at all is refused', () => {
    for (const junk of ['', '   ', 'marie', '12345', '+'])
      expect(() => phoneNumberOf(junk)).toThrow();
  });
});

describe('which of the two ids the allowlist needs', () => {
  test('the lid wins when WhatsApp has one, since that is what arrives on a message', () => {
    const lookup = senderLookup(' +41 79 123 45 67 ', '41791234567', {
      exists: true,
      jid: PN,
      lid: LID,
    });
    expect(lookup).toEqual({
      query: '+41 79 123 45 67',
      number: '41791234567',
      exists: true,
      jid: PN,
      lid: LID,
      id: LID,
    });
  });

  test('an account WhatsApp has not moved keeps the phone form as its id', () => {
    expect(senderLookup('x', '41791234567', { exists: true, jid: PN, lid: null }).id).toBe(PN);
  });

  test('a number nobody holds on WhatsApp yields no id to add', () => {
    expect(senderLookup('x', '41791234567', { exists: false, jid: null, lid: null }).id).toBe(null);
  });
});

describe('the resolve_sender action', () => {
  beforeEach(() => {
    accounts.set('w0', { id: 'w0', phone: '41791234567' });
  });
  afterEach(() => {
    accounts.clear();
  });

  test('it asks WhatsApp with the digits alone and answers the id to add', async () => {
    const asked: string[] = [];
    const handle = makeHandleCall(() => fakeClient({ exists: true, jid: PN, lid: LID }, asked));
    const cap = captureResponses();
    await handle({
      op: 'call',
      id: 'a',
      action: 'resolve_sender',
      args: { query: '+41 79 123 45 67' },
    });
    cap.restore();
    expect(asked).toEqual(['41791234567']);
    expect(cap.responses[0]?.result).toEqual({
      account: 'w0',
      query: '+41 79 123 45 67',
      number: '41791234567',
      exists: true,
      jid: PN,
      lid: LID,
      id: LID,
    });
  });

  test('a number that cannot be read never reaches WhatsApp', async () => {
    const asked: string[] = [];
    const handle = makeHandleCall(() => fakeClient({ exists: true, jid: PN, lid: LID }, asked));
    const cap = captureResponses();
    await handle({ op: 'call', id: 'b', action: 'resolve_sender', args: { query: '079 123 45 67' } });
    cap.restore();
    expect(asked).toEqual([]);
    expect(cap.responses[0]?.error).toContain('national number');
  });
});
