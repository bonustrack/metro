import { describe, expect, test } from 'bun:test';
import { DisconnectReason } from 'baileys';
import { terminalReason } from '../src/client.ts';

describe('which disconnects metro refuses to reconnect from', () => {
  test('connectionReplaced is terminal — reconnecting is what causes the 463 loop', () => {
    const reason = terminalReason(DisconnectReason.connectionReplaced);
    expect(reason).toContain('another metro took this device');
    expect(reason).toContain('463');
  });

  test('loggedOut is terminal and says a re-pair is needed', () => {
    expect(terminalReason(DisconnectReason.loggedOut)).toContain('re-pair');
  });

  test('an ordinary drop is NOT terminal, so the train still reconnects', () => {
    for (const code of [
      DisconnectReason.connectionLost,
      DisconnectReason.connectionClosed,
      DisconnectReason.restartRequired,
      DisconnectReason.timedOut,
      undefined,
    ])
      expect(terminalReason(code)).toBeUndefined();
  });
});
