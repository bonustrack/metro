import { afterEach, describe, expect, test } from 'bun:test';
import { setAgentMap, knownAccounts } from '../src/db/agent-map.ts';

afterEach(() => {
  setAgentMap({}, {});
});

describe('the accounts a daemon knows about, train or no train', () => {
  test('come from the agent map, which every station source fills, not from a database', () => {
    setAgentMap(
      { 'telegram-bot/stn00000001': 'agentTony01', 'xmtp/stn00000002': 'agentTony01' },
      { agentTony01: 'Tony' },
    );
    expect(knownAccounts().sort((a, b) => a.station.localeCompare(b.station))).toEqual([
      { station: 'telegram-bot', id: 'stn00000001', agentId: 'agentTony01' },
      { station: 'xmtp', id: 'stn00000002', agentId: 'agentTony01' },
    ]);
  });

  test('an empty map is an empty list', () => {
    expect(knownAccounts()).toEqual([]);
  });
});
