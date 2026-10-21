import { describe, expect, test } from 'bun:test';
import { groupAccounts } from '../src/api/accounts.js';
import { channelTrouble, connectionWords, pairAgainLines, pairedWords, troubleLine } from '../src/api/pair-again.js';

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const LOGGED_OUT = { state: 'logged_out', reason: 'WhatsApp removed this linked device.', since: NOW - 6 * HOUR };

const PAYLOAD = {
  whatsapp: [
    { id: 'waLisa00001', handle: '+447700900123', connected: true, status: LOGGED_OUT },
    { id: 'waOk0000001', handle: '+447700900124', status: { state: 'connected', since: NOW - HOUR } },
    { id: 'waOld000001', handle: '+447700900125', connected: true },
  ],
  'telegram-bot': [{ id: 'tg00000001', status: { state: 'disconnected', since: NOW } }],
};

describe('the live state of a channel on the page', () => {
  test('the state is read, never shown as a detail, and the stale connected flag is gone', () => {
    const rows = groupAccounts(PAYLOAD).find((g) => g.station === 'whatsapp')?.rows ?? [];
    expect(rows.map((r) => r.status?.state ?? null)).toEqual(['logged_out', 'connected', null]);
    for (const row of rows) expect(row.fields.map((f) => f.label)).toEqual(['id', 'handle']);
  });

  test('each state reads in plain words with how long ago', () => {
    expect(connectionWords(null, NOW)).toEqual({ title: 'Unknown', note: 'Metro could not read the connection just now.', tone: 'secondary' });
    expect(connectionWords({ state: 'connected', since: NOW - HOUR }, NOW)).toEqual({ title: 'Connected', note: 'Connected 1 h ago.', tone: 'default' });
    expect(connectionWords({ state: 'connecting', reason: 'The connection dropped (code 408).', since: NOW }, NOW).title).toBe('Reconnecting');
    expect(connectionWords({ state: 'logged_out', reason: 'WhatsApp removed this linked device.', since: NOW - 6 * HOUR }, NOW)).toEqual({
      title: 'Logged out',
      note: 'WhatsApp removed this linked device. Logged out 6 h ago. Pair again to get messages.',
      tone: 'danger',
    });
    expect(connectionWords({ state: 'disconnected', since: NOW - 2 * HOUR }, NOW)).toMatchObject({ title: 'Disconnected', note: 'Metro lost the connection. Disconnected 2 h ago.' });
  });

  test('a logged out or disconnected channel needs attention, a working or unknown one does not', () => {
    const trouble = channelTrouble(groupAccounts(PAYLOAD));
    expect(trouble.map((t) => [t.station, t.accountId, t.status.state])).toEqual([
      ['telegram-bot', 'tg00000001', 'disconnected'],
      ['whatsapp', 'waLisa00001', 'logged_out'],
    ]);
    expect(trouble.map(troubleLine)).toEqual(['Telegram bot disconnected', 'WhatsApp logged out: pair again']);
    expect(channelTrouble(undefined)).toEqual([]);
  });

  test('a saved pairing promises a reconnect only when Metro restarted the channel', () => {
    expect(pairedWords('WhatsApp', true)).toBe('Paired again. WhatsApp reconnects within a few seconds.');
    expect(pairedWords('WhatsApp', false)).toBe("The pairing is saved, but Metro could not restart WhatsApp yet. It connects at Metro's next restart.");
  });

  test('pairing again says what stays and what to do on the phone', () => {
    expect(pairAgainLines('WhatsApp', '+447700900123', false)).toEqual([
      'WhatsApp logged Metro out. Pair the phone of +447700900123 again to get messages. People, approvers and rules stay as they are.',
    ]);
    expect(pairAgainLines('WhatsApp', undefined, true)).toEqual([
      'The current link is replaced. Pair the same phone again. People, approvers and rules stay as they are.',
      'Then remove the old Metro entry from Linked Devices on that phone.',
    ]);
  });
});
