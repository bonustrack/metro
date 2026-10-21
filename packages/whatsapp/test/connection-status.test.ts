import { afterEach, describe, expect, test } from 'bun:test';
import { DisconnectReason } from 'baileys';
import { closeOf, ConnectionWatch, failureOf, RECONNECT_GRACE_MS, SILENT_MS, statusAfterClose } from '../src/connection.ts';
import { TrainError } from '@metro-labs/core/train-error';
import { fixture } from './client-fixture.ts';
import type { WAClient } from '../src/client-types.ts';

const T0 = 1_800_000_000_000;

const streamError = (statusCode: number, data?: unknown): Error =>
  Object.assign(new Error(`Stream Errored (${statusCode})`), { output: { statusCode }, data });

const DEVICE_REMOVED = streamError(DisconnectReason.loggedOut, { tag: 'conflict', attrs: { type: 'device_removed' } });

function captureStderr(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  return { lines, restore: () => { process.stderr.write = orig; } };
}

describe('what a WhatsApp close means for the channel', () => {
  test('the 401 device_removed stream error is a logout that names the removed device', () => {
    const closed = closeOf(DEVICE_REMOVED);
    expect(closed).toEqual({ code: 401, message: 'Stream Errored (401)', removed: true });
    expect(statusAfterClose(closed, T0)).toEqual({ state: 'logged_out', reason: 'WhatsApp removed this linked device.', since: T0 });
  });

  test('any other 401 is a logout too, and a replaced connection is a disconnect', () => {
    expect(statusAfterClose(closeOf(streamError(401)), T0).state).toBe('logged_out');
    expect(statusAfterClose(closeOf(streamError(DisconnectReason.connectionReplaced)), T0).state).toBe('disconnected');
  });

  test('an ordinary drop reconnects and says why', () => {
    const status = statusAfterClose(closeOf(streamError(DisconnectReason.connectionLost)), T0);
    expect(status.state).toBe('connecting');
    expect(status.reason).toContain('code 408');
    expect(closeOf(undefined)).toEqual({ code: undefined, message: '', removed: false });
  });

  test('missing credentials need a pairing, any other start failure is a disconnect', () => {
    expect(failureOf(new TrainError('whatsapp_auth', 'no creds'), 'connect').state).toBe('logged_out');
    expect(failureOf(new Error('offline'), 'reconnect')).toMatchObject({ state: 'disconnected', reason: 'Metro could not reconnect to WhatsApp: offline' });
  });
});

describe('the live state of one account', () => {
  test('a logout stays a logout, whatever the socket says next', () => {
    const watch = new ConnectionWatch('w0', () => true, T0);
    watch.opened(T0);
    watch.closed(closeOf(DEVICE_REMOVED), T0 + 1);
    expect(watch.read(T0 + RECONNECT_GRACE_MS * 10)).toEqual({ state: 'logged_out', reason: 'WhatsApp removed this linked device.', since: T0 + 1 });
  });

  test('a drop that does not come back within the grace is a disconnect from when the grace ran out', () => {
    const watch = new ConnectionWatch('w0', () => true, T0);
    watch.opened(T0);
    watch.closed(closeOf(streamError(DisconnectReason.connectionLost)), T0 + 1000);
    expect(watch.read(T0 + 2000).state).toBe('connecting');
    watch.closed(closeOf(streamError(DisconnectReason.connectionClosed)), T0 + 60_000);
    expect(watch.read(T0 + 61_000).since).toBe(T0 + 1000);
    const down = watch.read(T0 + 1000 + RECONNECT_GRACE_MS);
    expect(down.state).toBe('disconnected');
    expect(down.since).toBe(T0 + 1000 + RECONNECT_GRACE_MS);
    expect(down.reason).toContain('has not come back');
    watch.closed(closeOf(streamError(DisconnectReason.connectionClosed)), T0 + RECONNECT_GRACE_MS * 2);
    expect(watch.read(T0 + RECONNECT_GRACE_MS * 2).state).toBe('disconnected');
    watch.opened(T0 + RECONNECT_GRACE_MS * 3);
    expect(watch.read(T0 + RECONNECT_GRACE_MS * 3)).toEqual({ state: 'connected', since: T0 + RECONNECT_GRACE_MS * 3 });
  });

  test('open but silent is not connected, and a frame brings it back', () => {
    const watch = new ConnectionWatch('w0', () => true, T0);
    watch.opened(T0);
    expect(watch.read(T0 + SILENT_MS).state).toBe('connected');
    expect(watch.read(T0 + SILENT_MS + 1)).toEqual({ state: 'connecting', reason: 'WhatsApp stopped answering.', since: T0 + SILENT_MS + 1 });
    watch.heard(T0 + SILENT_MS + 5);
    expect(watch.read(T0 + SILENT_MS + 6).state).toBe('connected');
  });

  test('open in Baileys but a closed websocket is not connected', () => {
    let socketOpen = true;
    const watch = new ConnectionWatch('w0', () => socketOpen, T0);
    watch.opened(T0);
    socketOpen = false;
    expect(watch.read(T0 + 1)).toMatchObject({ state: 'connecting', reason: 'The WhatsApp connection is not open.' });
  });

  test('each change of state writes one line naming the account only', () => {
    const cap = captureStderr();
    const watch = new ConnectionWatch('w0', () => true, T0);
    watch.opened(T0);
    watch.opened(T0 + 1);
    watch.closed(closeOf(DEVICE_REMOVED), T0 + 2);
    watch.read(T0 + 3);
    cap.restore();
    expect(cap.lines).toEqual([
      'whatsapp[w0] state connecting -> connected\n',
      'whatsapp[w0] state connected -> logged_out: WhatsApp removed this linked device.\n',
    ]);
  });
});

describe('the client reports what WhatsApp did', () => {
  const clients: WAClient[] = [];
  afterEach(async () => {
    await Promise.all(clients.splice(0).map((c) => c.disconnect()));
  });

  test('connected once open, then logged out on the device_removed stream error', async () => {
    const f = await fixture(clients);
    expect(f.client.status().state).toBe('connected');
    f.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: DEVICE_REMOVED, date: new Date() } });
    expect(f.client.status()).toMatchObject({ state: 'logged_out', reason: 'WhatsApp removed this linked device.' });
  });
});
