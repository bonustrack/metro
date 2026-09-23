import { describe, expect, test } from 'bun:test';
import { InboundRelay } from '../src/channels/inbound.ts';
import { senderPermitted } from '../src/agents/map.ts';
import { trainEventToMetroEvent } from '../src/routes/http.ts';
import { stationByName } from '../src/stations/registry.ts';
import type { Notif } from './relay-fixture.ts';

const LINE = 'metro://outlook/o1/AAQkAD=';
const FROM = 'metro://outlook/o1/user/bea@anderra.ch';

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
    getStations: () => new Set(['outlook', 'discord-bot']),
    senderAllowed: (from, _line, verified) => senderPermitted(allowlist, from, verified),
    approves: (station) => stationByName(station)?.approvals !== false,
  });
  return { relay, notifs };
}

const mail = (text: string, senderVerified?: boolean): Record<string, unknown> => ({
  event: { type: 'msg' },
  station: 'outlook',
  line: LINE,
  from: FROM,
  text,
  messageId: `m-${text}`,
  ...(senderVerified === undefined ? {} : { senderVerified }),
});

describe('a verified sender, on the wire', () => {
  test('the train fact becomes an event field, true and false alike', () => {
    expect(trainEventToMetroEvent({ line: LINE, sender_verified: false }, 'outlook')?.senderVerified).toBe(false);
    expect(trainEventToMetroEvent({ line: LINE, sender_verified: true }, 'outlook')?.senderVerified).toBe(true);
    expect(trainEventToMetroEvent({ line: LINE }, 'outlook')?.senderVerified).toBeUndefined();
  });
});

describe('the allowlist trusts only a verified sender', () => {
  test('a listed address or domain is honoured only when the station verified it', async () => {
    const { relay, notifs } = relayWith(['@anderra.ch']);
    await relay.handleEvent(mail('forged', false));
    await relay.handleEvent(mail('real', true));
    expect(notifs.map((n) => n.params.content)).toEqual(['real']);
    expect(notifs[0]?.params.meta?.sender_verified).toBe('true');
  });

  test('a station that does not report the fact is unchanged', () => {
    expect(senderPermitted(['bea@anderra.ch'], FROM, undefined)).toBe(true);
    expect(senderPermitted(['bea@anderra.ch'], FROM, false)).toBe(false);
  });

  test('with anyone allowed an unverified mail still arrives, and says so', async () => {
    const { relay, notifs } = relayWith(['*']);
    await relay.handleEvent(mail('hello', false));
    expect(notifs).toHaveLength(1);
    expect(notifs[0]?.params.meta?.sender_verified).toBe('false');
  });
});

describe('approvals never go through email', () => {
  test('an outlook line never becomes the line a permission prompt is sent to', async () => {
    const { relay } = relayWith(['*']);
    await relay.handleEvent({ event: { type: 'msg' }, station: 'discord-bot', line: 'metro://discord-bot/d1/99', from: 'metro://discord-bot/d1/user/7', text: 'hi', messageId: 'd1' });
    await relay.handleEvent(mail('later', true));
    expect(relay.knownLine).toBe('metro://discord-bot/d1/99');
  });

  test('a yes <id> by email is an ordinary message, never an answer', async () => {
    const { relay, notifs } = relayWith(['*']);
    relay.registerPermission('abcde', LINE);
    await relay.handleEvent(mail('yes abcde', true));
    const methods = notifs.map((n) => n.method);
    expect(methods).toEqual(['notifications/claude/channel']);
    expect(notifs[0]?.params.content).toBe('yes abcde');
  });
});
