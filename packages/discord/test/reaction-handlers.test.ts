import { describe, expect, test } from 'bun:test';
import { Events, type Client } from 'discord.js';
import { attachHandlers } from '../src/handlers.ts';

type Handler = (...a: unknown[]) => void;

function wire(): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const client = {
    on: (event: string, fn: Handler) => {
      handlers.set(event, fn);
      return client;
    },
  } as unknown as Client;
  attachHandlers(client, 'd0');
  return handlers;
}

const reaction = {
  partial: false,
  message: { channelId: 'chan1', id: 'm1', guildId: null },
  emoji: { name: '🔥', id: null, toJSON: () => ({}) },
};
const user = { partial: false, bot: false, id: '999', username: 'less' };

async function emitted(event: string): Promise<Record<string, unknown>[]> {
  const handler = wire().get(event);
  if (!handler) throw new Error(`nothing subscribed to ${event}`);
  const orig = process.stdout.write.bind(process.stdout);
  const lines: string[] = [];
  // @ts-expect-error narrow override for the test
  process.stdout.write = (chunk: string) => {
    lines.push(chunk);
    return true;
  };
  try {
    handler(reaction, user);
    await new Promise((r) => setTimeout(r, 10));
  } finally {
    process.stdout.write = orig;
  }
  return lines.map((l) => JSON.parse(l.trim()) as Record<string, unknown>);
}

describe('the discord train reports both directions of a reaction', () => {
  test('an added reaction becomes an event', async () => {
    const out = await emitted(Events.MessageReactionAdd);
    expect(out).toHaveLength(1);
    expect(out[0].emoji).toBe('🔥');
    expect((out[0].payload as { removed: boolean }).removed).toBe(false);
  });

  test('a removed reaction becomes an event', async () => {
    const out = await emitted(Events.MessageReactionRemove);
    expect(out).toHaveLength(1);
    expect(out[0].emoji).toBe('🔥');
    expect((out[0].payload as { removed: boolean }).removed).toBe(true);
  });
});
