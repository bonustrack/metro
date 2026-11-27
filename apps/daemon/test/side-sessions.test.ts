import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { SIDE_IDLE_MS, SIDE_MAX, SideSessions } from '../src/mcp/side-sessions.ts';

const clock = (): { now: () => number; advance: (ms: number) => void } => {
  let at = 1_000_000;
  return {
    now: () => at,
    advance: (ms) => {
      at += ms;
    },
  };
};

describe('side sessions for other clients on the box', () => {
  test('at most SIDE_MAX stay open, and the least recently used one goes first', async () => {
    const time = clock();
    const sides = new SideSessions(() => undefined, time.now);
    const ids: string[] = [];
    for (let i = 0; i <= SIDE_MAX; i++) {
      const id = `side-${String(i)}`;
      await sides.start(id);
      ids.push(id);
      time.advance(1_000);
    }
    expect(sides.size).toBe(SIDE_MAX);
    expect(sides.find(ids[0] ?? '')).toBeUndefined();
    expect(sides.find(ids[SIDE_MAX] ?? '')).toBeDefined();
    await sides.closeAll();
    expect(sides.size).toBe(0);
  });

  test('a side session idle for longer than SIDE_IDLE_MS is closed', async () => {
    const time = clock();
    const sides = new SideSessions(() => undefined, time.now);
    await sides.start('idle');
    await sides.start('busy');
    time.advance(SIDE_IDLE_MS - 1_000);
    expect(sides.find('busy')).toBeDefined();
    time.advance(2_000);
    expect(sides.find('idle')).toBeUndefined();
    expect(sides.find('busy')).toBeDefined();
    await sides.closeAll();
  });

  test('two requests adopting the same id share one side session', async () => {
    const sides = new SideSessions(() => undefined);
    const [first, second] = await Promise.all([sides.start('same'), sides.start('same')]);
    expect(first).toBe(second);
    expect(sides.size).toBe(1);
    await sides.closeAll();
  });
});

describe('a side session in the middle of a request', () => {
  test('is never the one dropped for room or for idleness, and goes back to normal once its request ends', async () => {
    const time = clock();
    const sides = new SideSessions(() => undefined, time.now);
    const chat = await sides.start('chat-call');
    const res = new EventEmitter() as unknown as ServerResponse;
    sides.serving(chat, res);
    time.advance(1_000);
    for (let i = 0; i < SIDE_MAX; i++) {
      await sides.start(`storm-${String(i)}`);
      time.advance(1_000);
    }
    expect(sides.find('chat-call')).toBe(chat);
    time.advance(SIDE_IDLE_MS + 1_000);
    expect(sides.find('chat-call')).toBe(chat);
    (res as unknown as EventEmitter).emit('close');
    time.advance(SIDE_IDLE_MS + 1_000);
    expect(sides.find('chat-call')).toBeUndefined();
    await sides.closeAll();
  });

  test('when every side is busy, a new one is still served and the cap is exceeded until a request ends', async () => {
    const sides = new SideSessions(() => undefined);
    for (let i = 0; i < SIDE_MAX; i++) sides.serving(await sides.start(`busy-${String(i)}`), new EventEmitter() as unknown as ServerResponse);
    await sides.start('newcomer');
    expect(sides.size).toBe(SIDE_MAX + 1);
    expect(sides.find('newcomer')).toBeDefined();
    await sides.closeAll();
  });
});
