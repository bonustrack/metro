import { describe, expect, test } from 'bun:test';
import { InboundRelay } from '../src/channels/inbound.ts';
import {
  makeDedupSeq,
  makeEmit,
  trainEventToMetroEvent,
} from '../src/daemon/http.ts';
import { daemonSelf, type MetroEvent } from '../src/daemon/events.ts';
import type { TrainEvent } from '../src/daemon/protocol.ts';
import type { Line } from '../src/stations/lines.ts';

const LINE = 'metro://discord/d0/1504226489359401221' as Line;
const TARGET = '1538927976861663383';

const base = (overrides: Partial<MetroEvent> = {}): MetroEvent => ({
  id: 'msg_x',
  ts: '2026-08-17T15:10:21.000Z',
  station: 'discord',
  line: LINE,
  from: 'metro://discord/d0/user/238307675501232128' as Line,
  to: 'metro://user' as Line,
  text: 'hello',
  messageId: TARGET,
  event: { type: 'msg' },
  ...overrides,
});

const ourSend = (): MetroEvent =>
  base({ id: 'msg_sent', from: daemonSelf(), to: LINE });

const react = (emoji: string, id: string, removed = false): MetroEvent =>
  base({
    id,
    text: `[react ${emoji}]`,
    event: { type: 'react', emoji, targetId: TARGET },
    payload: { removed },
  });

const by = (e: MetroEvent, who: string): MetroEvent => ({
  ...e,
  from: `metro://discord/d0/user/${who}` as Line,
});

function emitAll(entries: MetroEvent[]): MetroEvent[] {
  const orig = process.stdout.write.bind(process.stdout);
  const lines: string[] = [];
  // @ts-expect-error narrow override for the test
  process.stdout.write = (chunk: string) => {
    lines.push(chunk);
    return true;
  };
  try {
    const emit = makeEmit(makeDedupSeq());
    for (const e of entries) emit(e);
  } finally {
    process.stdout.write = orig;
  }
  return lines.map((l) => JSON.parse(l.trim()) as MetroEvent);
}

type Notif = { method: string; params: Record<string, unknown> };

function makeRelay(): { relay: InboundRelay; notifs: Notif[] } {
  const notifs: Notif[] = [];
  const relay = new InboundRelay({
    mcp: {
      notification: (n: Notif) => {
        notifs.push(n);
        return Promise.resolve();
      },
    } as never,
    log: () => {},
    getStations: () => new Set(['discord']),
    senderAllowed: () => true,
  });
  return { relay, notifs };
}

async function deliver(relay: InboundRelay, events: MetroEvent[]): Promise<void> {
  for (const e of events)
    await relay.handleEvent(e as unknown as Record<string, unknown>);
}

const contents = (notifs: Notif[]): string[] =>
  notifs
    .filter((n) => n.method === 'notifications/claude/channel')
    .map((n) => String(n.params.content));

describe('daemon dedupe admits a reaction on a message it already saw', () => {
  test('a react on a message we sent ourselves reaches the bus', () => {
    const out = emitAll([ourSend(), react('🔥', 'msg_fire')]);
    expect(out.map((e) => e.id)).toEqual(['msg_sent', 'msg_fire']);
  });

  test('a react on an inbound message reaches the bus', () => {
    const out = emitAll([base({ id: 'msg_his' }), react('🔥', 'msg_fire')]);
    expect(out.map((e) => e.id)).toEqual(['msg_his', 'msg_fire']);
  });

  test('two emojis on one message are two events, the same emoji twice is one', () => {
    const out = emitAll([
      react('🔥', 'msg_fire'),
      react('👀', 'msg_eyes'),
      react('🔥', 'msg_fire_again'),
    ]);
    expect(out.map((e) => e.id)).toEqual(['msg_fire', 'msg_eyes']);
  });

  test('removing a reaction is not a duplicate of adding it', () => {
    const out = emitAll([
      react('🔥', 'msg_fire'),
      react('🔥', 'msg_unfire', true),
    ]);
    expect(out.map((e) => e.id)).toEqual(['msg_fire', 'msg_unfire']);
  });

  test('our own reaction does not swallow the same reaction from a person', () => {
    const ours: MetroEvent = {
      ...react('👀', 'msg_our_ack'),
      from: daemonSelf(),
      to: LINE,
    };
    const out = emitAll([ours, react('👀', 'msg_his_eyes')]);
    expect(out.map((e) => e.id)).toEqual(['msg_our_ack', 'msg_his_eyes']);
  });

  test('two people reacting with the same emoji are two events', () => {
    const out = emitAll([
      by(react('🔥', 'msg_alice'), 'alice'),
      by(react('🔥', 'msg_bob'), 'bob'),
    ]);
    expect(out.map((e) => e.id)).toEqual(['msg_alice', 'msg_bob']);
  });

  test('adding, taking away and adding again is three events', () => {
    const out = emitAll([
      react('🔥', 'msg_on'),
      react('🔥', 'msg_off', true),
      react('🔥', 'msg_on_again'),
    ]);
    expect(out.map((e) => e.id)).toEqual(['msg_on', 'msg_off', 'msg_on_again']);
  });

  test('an emoji-less removal from two people is two events', () => {
    const out = emitAll([
      by(react('', 'msg_alice_off', true), 'alice'),
      by(react('', 'msg_bob_off', true), 'bob'),
    ]);
    expect(out.map((e) => e.id)).toEqual(['msg_alice_off', 'msg_bob_off']);
  });

  test('a removal marked only in the text still toggles', () => {
    const xmtp = (id: string, removed: boolean): MetroEvent =>
      base({
        id,
        station: 'xmtp',
        text: `[react 👍${removed ? ' (removed)' : ''}]`,
        event: { type: 'react', emoji: '👍', targetId: TARGET },
      });
    const out = emitAll([
      xmtp('msg_on', false),
      xmtp('msg_off', true),
      xmtp('msg_on_again', false),
    ]);
    expect(out.map((e) => e.id)).toEqual(['msg_on', 'msg_off', 'msg_on_again']);
  });

  test('a reaction recognised only by its payload is not the message', () => {
    const classified = base({
      id: 'msg_payload_react',
      text: undefined,
      event: undefined,
      payload: { emoji: '🔥' },
    });
    const out = emitAll([base({ id: 'msg_theirs' }), classified]);
    expect(out.map((e) => e.id)).toEqual(['msg_theirs', 'msg_payload_react']);
  });

  test('a message redelivered with the same id is still deduped', () => {
    const out = emitAll([base({ id: 'msg_his' }), base({ id: 'msg_his_again' })]);
    expect(out.map((e) => e.id)).toEqual(['msg_his']);
  });
});

describe('every station that reports reactions gets them through', () => {
  const stations: {
    station: string;
    line: string;
    add: TrainEvent;
    off: TrainEvent;
  }[] = [
    {
      station: 'discord',
      line: 'metro://discord/d0/chan1',
      add: { emoji: '🔥', payload: { removed: false } },
      off: { emoji: '🔥', payload: { removed: true } },
    },
    {
      station: 'telegram',
      line: 'metro://telegram/t0/-100123',
      add: { emoji: '🔥', payload: { removed: false } },
      off: { emoji: '🔥', payload: { removed: true } },
    },
    {
      station: 'telegram-user',
      line: 'metro://telegram-user/default/-812222116',
      add: { emoji: '🔥', payload: { removed: false } },
      off: { emoji: '🔥', payload: { removed: true } },
    },
    {
      station: 'whatsapp',
      line: 'metro://whatsapp/a2/71425507483880@lid',
      add: { emoji: '👍', payload: { removed: false } },
      off: { emoji: '', payload: { removed: true } },
    },
    {
      station: 'xmtp',
      line: 'metro://xmtp/tony/0xconv',
      add: { text: '[react 👍]', payload: { removed: false } },
      off: { text: '[react 👍 (removed)]', payload: { removed: true } },
    },
  ];

  for (const s of stations) {
    test(`${s.station}: the add, the removal and the message itself are distinct`, () => {
      const envelopeOf = (e: TrainEvent): MetroEvent => {
        const env = trainEventToMetroEvent(
          {
            station: s.station,
            line: s.line,
            from: `metro://${s.station}/who`,
            message_id: TARGET,
            ...e,
          },
          s.station,
        );
        if (!env) throw new Error('no envelope');
        return env;
      };
      const reaction = (e: TrainEvent, id: string): MetroEvent =>
        envelopeOf({
          ...e,
          id,
          event: { type: 'react', emoji: e.emoji ?? '', targetId: TARGET },
        });
      const out = emitAll([
        envelopeOf({ id: 'msg_theirs', text: 'the message being reacted to' }),
        reaction(s.add, 'msg_add'),
        reaction(s.off, 'msg_off'),
      ]);
      expect(out.map((e) => e.id)).toEqual(['msg_theirs', 'msg_add', 'msg_off']);
    });
  }
});

describe('relay dedupe surfaces each reaction on one message', () => {
  test('two emojis inside the dedupe window both surface', async () => {
    const { relay, notifs } = makeRelay();
    await deliver(relay, [react('🔥', 'msg_fire'), react('👀', 'msg_eyes')]);
    expect(contents(notifs)).toEqual([
      `🔥 reacted to message ${TARGET.slice(0, 6)}…`,
      `👀 reacted to message ${TARGET.slice(0, 6)}…`,
    ]);
  });

  test('an add and its removal both surface', async () => {
    const { relay, notifs } = makeRelay();
    await deliver(relay, [
      react('🔥', 'msg_fire'),
      react('🔥', 'msg_unfire', true),
    ]);
    expect(contents(notifs)).toEqual([
      `🔥 reacted to message ${TARGET.slice(0, 6)}…`,
      `🔥 removed from message ${TARGET.slice(0, 6)}…`,
    ]);
  });

  test('the same emoji from two people surfaces twice', async () => {
    const { relay, notifs } = makeRelay();
    await deliver(relay, [
      by(react('🔥', 'msg_alice'), 'alice'),
      by(react('🔥', 'msg_bob'), 'bob'),
    ]);
    expect(contents(notifs)).toHaveLength(2);
  });

  test('the same reaction twice surfaces once', async () => {
    const { relay, notifs } = makeRelay();
    await deliver(relay, [react('🔥', 'msg_fire'), react('🔥', 'msg_dup')]);
    expect(contents(notifs)).toHaveLength(1);
  });
});
