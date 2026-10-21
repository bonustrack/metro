import { EventEmitter } from 'node:events';
import { describe, expect, test } from 'bun:test';
import type { WASocket } from 'baileys';
import { assertSamePhone, normalizePhone, WhatsappLogin, WhatsappLoginError, type WhatsappLoginEvents } from '../src/login.ts';
import type { ClientRuntime } from '../src/client-types.ts';

describe('normalizePhone', () => {
  test('strips the formatting people paste', () => {
    expect(normalizePhone('+44 (770) 090-0123')).toBe('447700900123');
    expect(normalizePhone('447700900123')).toBe('447700900123');
  });

  test('a blank phone means QR mode, not an error', () => {
    expect(normalizePhone('')).toBe('');
    expect(normalizePhone(undefined)).toBe('');
    expect(normalizePhone(null)).toBe('');
    expect(normalizePhone(42)).toBe('');
  });

  test('a number that cannot be a phone is refused', () => {
    for (const phone of ['12345', '0'.repeat(20), '+44 abc'])
      expect(() => normalizePhone(phone)).toThrow(WhatsappLoginError);
  });

  test('the refusal explains the format instead of echoing the input', () => {
    try {
      normalizePhone('12345');
      throw new Error('should have been refused');
    } catch (err) {
      expect((err as Error).message).toContain('447700900123');
      expect((err as Error).message).not.toContain('12345');
    }
  });
});

interface FakeLogin {
  runtime: ClientRuntime;
  open: () => void;
  loggedOut: () => number;
}

function fakeLogin(linked: string): FakeLogin {
  const ev = new EventEmitter();
  let logouts = 0;
  const sock = {
    ev,
    end: () => Promise.resolve(),
    logout: () => {
      logouts += 1;
      return Promise.resolve();
    },
  } as unknown as WASocket;
  const runtime: ClientRuntime = {
    makeSocket: (config) => {
      config.auth.creds.me = { id: `${linked}:7@s.whatsapp.net` };
      return sock;
    },
    fetchVersion: () => Promise.resolve({ version: [2, 3000, 1], isLatest: true }),
  };
  return { runtime, open: () => ev.emit('connection.update', { connection: 'open' }), loggedOut: () => logouts };
}

interface Settled {
  paired?: string;
  failed?: string;
}

function events(): { events: WhatsappLoginEvents; settled: Promise<Settled> } {
  let done: (value: Settled) => void = () => undefined;
  const settled = new Promise<Settled>((resolve) => {
    done = resolve;
  });
  return {
    settled,
    events: {
      onQr: () => undefined,
      onPairingCode: () => undefined,
      onPaired: (result) => {
        done({ paired: result.config.phone });
      },
      onFailed: (message) => {
        done({ failed: message });
      },
    },
  };
}

describe('pairing a channel again', () => {
  test('a pairing code for another number is refused before WhatsApp is asked', () => {
    expect(() => new WhatsappLogin('447700900999', events().events, '447700900123')).toThrow('This channel is +447700900123');
    expect(() => {
      assertSamePhone('447700900123', '447700900123');
    }).not.toThrow();
    expect(() => {
      assertSamePhone('', '447700900123');
    }).not.toThrow();
  });

  test('a QR scanned by another phone is unlinked again and nothing is stored', async () => {
    const fake = fakeLogin('447700900999');
    const watch = events();
    const login = new WhatsappLogin('', watch.events, '447700900123', fake.runtime);
    await login.start();
    fake.open();
    const result = await watch.settled;
    expect(result.paired).toBeUndefined();
    expect(result.failed).toContain('You linked +447700900999, but this channel is +447700900123. Nothing was changed.');
    expect(fake.loggedOut()).toBe(1);
  });

  test('the same phone pairs again', async () => {
    const fake = fakeLogin('447700900123');
    const watch = events();
    const login = new WhatsappLogin('', watch.events, '447700900123', fake.runtime);
    await login.start();
    fake.open();
    expect(await watch.settled).toEqual({ paired: '447700900123' });
    expect(fake.loggedOut()).toBe(0);
  });
});
