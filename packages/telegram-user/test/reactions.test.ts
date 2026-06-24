import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { subscribeReactions } from '../src/reactions.ts';
import type { UserClient } from '../src/client.ts';

type Listener = (info: unknown) => void;

interface FakeEmitter {
  add: (l: Listener) => void;
  fire: (info: unknown) => void;
}

function fakeEmitter(): FakeEmitter {
  let listener: Listener | undefined;
  return {
    add: (l) => void (listener = l),
    fire: (info) => listener?.(info),
  };
}

function fakeClient(emitter: FakeEmitter): UserClient {
  const tg = { onRawUpdate: { add: emitter.add } };
  return {
    account: { id: 'default', session: 's' },
    tg,
  } as unknown as UserClient;
}

function reactionUpdate(
  recent: Array<Record<string, unknown>>,
  msgId = 42,
): unknown {
  return {
    update: {
      _: 'updateMessageReactions',
      peer: { _: 'peerUser', userId: 111 },
      msgId,
      reactions: { _: 'messageReactions', results: [], recentReactions: recent },
    },
    peers: {},
  };
}

const reactor = (userId: number, emoticon: string, my = false) => ({
  _: 'messagePeerReaction',
  peerId: { _: 'peerUser', userId },
  date: 0,
  my,
  reaction: { _: 'reactionEmoji', emoticon },
});

function captureEmits(): { events: Record<string, unknown>[]; restore: () => void } {
  const events: Record<string, unknown>[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    for (const line of String(chunk).split('\n').filter(Boolean))
      events.push(JSON.parse(line) as Record<string, unknown>);
    return true;
  }) as typeof process.stdout.write;
  return { events, restore: () => void (process.stdout.write = orig) };
}

describe('inbound reactions', () => {
  let emitter: FakeEmitter;

  beforeEach(() => {
    emitter = fakeEmitter();
  });
  afterEach(() => {});

  test('emits an add reactionEnvelope for a new reaction from another user', () => {
    subscribeReactions(fakeClient(emitter));
    const cap = captureEmits();
    emitter.fire(reactionUpdate([reactor(222, '👍')]));
    cap.restore();
    expect(cap.events).toHaveLength(1);
    expect(cap.events[0]).toMatchObject({
      kind: 'react',
      station: 'telegram-user',
      line: 'metro://telegram-user/default/111',
      from: 'metro://telegram-user/default/user/222',
      message_id: '42',
      event: { type: 'react', emoji: '👍', targetId: '42' },
      payload: { removed: false },
    });
  });

  test('emits a removed reactionEnvelope when a reaction disappears', () => {
    subscribeReactions(fakeClient(emitter));
    const cap = captureEmits();
    emitter.fire(reactionUpdate([reactor(222, '👍')], 43));
    emitter.fire(reactionUpdate([], 43));
    cap.restore();
    expect(cap.events).toHaveLength(2);
    expect(cap.events[1]).toMatchObject({
      kind: 'react',
      from: 'metro://telegram-user/default/user/222',
      message_id: '43',
      payload: { removed: true },
    });
  });

  test('filters out the session account own reaction (my flag)', () => {
    subscribeReactions(fakeClient(emitter));
    const cap = captureEmits();
    emitter.fire(reactionUpdate([reactor(999, '❤️', true)], 44));
    cap.restore();
    expect(cap.events).toHaveLength(0);
  });
});
