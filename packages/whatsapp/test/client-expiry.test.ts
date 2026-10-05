import { afterEach, beforeEach, describe, expect, test, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WAClient } from '../src/client.js';
import { createHistory } from '../src/history.js';
import { CHAT, SELF, fixture } from './client-fixture.js';

const clients: WAClient[] = [];
let dir: string;
let prior: string | undefined;
let clock: ReturnType<typeof spyOn<typeof Date, 'now'>> | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'metro-wa-client-expiry-'));
  prior = process.env.WHATSAPP_TOKEN_DIR;
  process.env.WHATSAPP_TOKEN_DIR = dir;
});
afterEach(async () => {
  for (const client of clients.splice(0)) await client.disconnect();
  clock?.mockRestore();
  clock = undefined;
  if (prior === undefined) delete process.env.WHATSAPP_TOKEN_DIR;
  else process.env.WHATSAPP_TOKEN_DIR = prior;
  rmSync(dir, { recursive: true, force: true });
});

describe('authoritative send-time expiry', () => {
  test('group snapshot supplies send options and survives restart without extending expiry', async () => {
    const now = Math.floor(Date.now() / 1000) * 1000;
    clock = spyOn(Date, 'now').mockReturnValue(now);
    const f = await fixture(clients);
    f.setMetadata(() => Promise.resolve(60));
    await f.client.sendText(CHAT, 'disappearing');
    expect(f.options[0]?.ephemeralExpiration).toBe(60);
    expect(f.generated[0]?.message).toEqual({ conversation: 'disappearing' });
    expect((await f.client.read(CHAT)).count).toBe(1);
    await f.client.disconnect();
    clock.mockReturnValue(now + 59_000);
    const reopened = createHistory('fixture');
    expect(reopened.read(CHAT).count).toBe(1);
    clock.mockReturnValue(now + 60_000);
    expect(reopened.read(CHAT).count).toBe(0);
    reopened.close();
  });

  test('known disabled groups remain ordinary; a failed metadata lookup never refuses a send', async () => {
    const f = await fixture(clients);
    await f.client.sendText(CHAT, 'ordinary');
    expect(f.options[0]?.ephemeralExpiration).toBe(0);
    f.setMetadata(() => Promise.reject(new Error('fixture metadata unavailable')));
    const id = await f.client.sendText(CHAT, 'unknown expiry');
    expect(id).toBe('out-2');
    expect(f.options[1]?.ephemeralExpiration).toBeUndefined();
    expect((await f.client.read(CHAT)).messages.map((m) => m.text)).toEqual(['ordinary']);
    expect(f.groupCalls).toBe(2);
  });

  test('unknown direct state is omitted, not guessed from absent or invalid fields', async () => {
    const f = await fixture(clients);
    f.ev.emit('chats.update', [{ id: SELF }, { id: SELF, ephemeralExpiration: 60 }, { id: SELF, ephemeralExpiration: -1, ephemeralSettingTimestamp: 1 }]);
    expect(await f.client.sendText(SELF, 'unknown direct')).toBe('out-1');
    expect(f.options[0]?.ephemeralExpiration).toBeUndefined();
    expect((await f.client.read(SELF)).count).toBe(0);
    expect(f.groupCalls).toBe(0);
  });

  test('direct explicit settings retain disabled sends and expire timed sends without stale overrides', async () => {
    const now = Math.floor(Date.now() / 1000) * 1000;
    clock = spyOn(Date, 'now').mockReturnValue(now);
    const f = await fixture(clients);
    f.ev.emit('chats.update', [{ id: SELF, ephemeralExpiration: null, ephemeralSettingTimestamp: now / 1000 - 10 }]);
    await f.client.sendText(SELF, 'disabled');
    expect(f.options[0]?.ephemeralExpiration).toBe(0);
    f.ev.emit('chats.update', [{ id: SELF, ephemeralExpiration: 60, ephemeralSettingTimestamp: now / 1000 }]);
    f.ev.emit('chats.update', [{ id: SELF, ephemeralExpiration: null, ephemeralSettingTimestamp: now / 1000 - 5 }]);
    await f.client.sendText(SELF, 'timed');
    expect(f.options[1]?.ephemeralExpiration).toBe(60);
    expect((await f.client.read(SELF)).count).toBe(2);
    clock.mockReturnValue(now + 60_000);
    expect((await f.client.read(SELF)).messages.map((m) => m.text)).toEqual(['disabled']);
  });

  test('closing during a metadata lookup prevents a later send', async () => {
    const f = await fixture(clients);
    const metadata = Promise.withResolvers<number>();
    f.setMetadata(() => metadata.promise);
    const sent = f.client.sendText(CHAT, 'must not send').then(() => undefined, (err: unknown) => err);
    await Bun.sleep(1);
    await f.client.disconnect();
    metadata.resolve(60);
    expect(await sent).toMatchObject({ code: 'whatsapp_call', message: 'socket not connected' });
    expect(f.sent).toEqual([]);
  });

  test('no ACK still counts as sent and retains authoritative expiry', async () => {
    const f = await fixture(clients);
    f.setAutoAck(false);
    expect(await f.client.sendText(CHAT, 'no ACK')).toBe('out-1');
    expect((await f.client.read(CHAT)).messages[0]?.text).toBe('no ACK');
  }, 10_000);
});
