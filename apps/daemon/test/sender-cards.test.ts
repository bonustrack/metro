import { afterEach, describe, expect, test } from 'bun:test';
import { setAllowlistMap } from '../src/agents/map.ts';
import { senderCards, type SenderCardDeps } from '../src/agents/sender-cards.ts';

const deps = (profiles: Record<string, unknown>): SenderCardDeps => ({
  recentSenders: () => [{ id: '333', name: 'Seen Sam', at: '' }],
  accountCall: (_station, _action, args) => {
    const found = profiles[String(args.user)];
    return found instanceof Error ? Promise.reject(found) : Promise.resolve(found ?? { id: args.user });
  },
});

afterEach(() => {
  setAllowlistMap({});
});

describe('the names shown next to listed senders', () => {
  test('come from the network profile, then from recent messages, and a failed lookup keeps the id', async () => {
    setAllowlistMap({ 'telegram-bot/tb1': ['111', '222', '333', '444', '*'] });
    const cards = await senderCards(
      deps({ '111': { id: '111', name: '@ada', display_name: 'Ada Lovelace', avatar: 'https://cdn.example/ada.png' }, '222': { id: '222', name: '@bob' }, '444': new Error('down') }),
      'telegram-bot',
      'tb1',
    );
    expect(cards).toEqual([
      { id: '111', name: 'Ada Lovelace', handle: '@ada', avatar: 'https://cdn.example/ada.png' },
      { id: '222', name: '@bob' },
      { id: '333', name: 'Seen Sam' },
      { id: '444' },
    ]);
  });

  test('never look up a domain entry, and ask nothing of a station with no profiles', async () => {
    setAllowlistMap({ 'outlook/ol1': ['@anderra.ch', 'andy@anderra.ch'] });
    let asked = 0;
    const cards = await senderCards({ recentSenders: () => [], accountCall: () => { asked += 1; return Promise.resolve({}); } }, 'outlook', 'ol1');
    expect(cards).toEqual([{ id: 'andy@anderra.ch' }]);
    expect(asked).toBe(0);
  });
});
