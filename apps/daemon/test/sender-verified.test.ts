import { describe, expect, test } from 'bun:test';
import { InboundRelay } from '../src/channels/inbound.ts';
import { senderPermitted } from '../src/agents/map.ts';
import { trainEventToMetroEvent } from '../src/routes/http.ts';
import type { Notif } from './relay-fixture.ts';

const LINE = 'metro://discord-bot/d1/99';
const FROM = 'metro://discord-bot/d1/user/7';

function relayWith(allowlist: string[]): { relay: InboundRelay; notifs: Notif[] } {
  const notifs: Notif[] = [];
  const relay = new InboundRelay({
    mcp: {
      notification: (n: Notif) => {
        notifs.push(n);
        return Promise.resolve();
      },
    } as never,
    log: () => undefined,
    getStations: () => new Set(['discord-bot']),
    senderAllowed: (from, _line, verified) => senderPermitted(allowlist, from, verified),
  });
  return { relay, notifs };
}

const message = (text: string, senderVerified?: boolean): Record<string, unknown> => ({
  event: { type: 'msg' },
  station: 'discord-bot',
  line: LINE,
  from: FROM,
  text,
  messageId: `m-${text}`,
  ...(senderVerified === undefined ? {} : { senderVerified }),
});

describe('a verified sender, on the wire', () => {
  test('the train fact becomes an event field, true and false alike', () => {
    expect(trainEventToMetroEvent({ line: LINE, sender_verified: false }, 'discord-bot')?.senderVerified).toBe(false);
    expect(trainEventToMetroEvent({ line: LINE, sender_verified: true }, 'discord-bot')?.senderVerified).toBe(true);
    expect(trainEventToMetroEvent({ line: LINE }, 'discord-bot')?.senderVerified).toBeUndefined();
  });
});

describe('the allowlist trusts only a verified sender', () => {
  test('a listed sender is honoured only when the station did not say it is unverified', async () => {
    const { relay, notifs } = relayWith(['7']);
    await relay.handleEvent(message('forged', false));
    await relay.handleEvent(message('real', true));
    await relay.handleEvent(message('unsaid'));
    expect(notifs.map((n) => n.params.content)).toEqual(['real', 'unsaid']);
    expect(notifs[0]?.params.meta?.sender_verified).toBe('true');
  });

  test('a station that does not report the fact is unchanged', () => {
    expect(senderPermitted(['7'], FROM, undefined)).toBe(true);
    expect(senderPermitted(['7'], FROM, false)).toBe(false);
  });

  test('with anyone allowed an unverified message still arrives, and says so', async () => {
    const { relay, notifs } = relayWith(['*']);
    await relay.handleEvent(message('hello', false));
    expect(notifs).toHaveLength(1);
    expect(notifs[0]?.params.meta?.sender_verified).toBe('false');
  });
});
