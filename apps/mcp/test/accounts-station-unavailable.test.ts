import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { setTrainCallBackend } from '../src/daemon/train-call.ts';
import { gatherAccountsForAgents } from '../src/mcp/accounts.ts';
import { setAgentMap } from '../src/db/agent-map.ts';

const OWNED = { 'xmtp/x1': 'agent000001', 'xmtp/tony': 'agent000001', 'telegram-bot/t0': 'agent000001' };

beforeAll(() => {
  process.env.METRO_RUN_TOKEN = 'test-runtime';
});

afterAll(() => {
  delete process.env.METRO_RUN_TOKEN;
});

describe('a station whose train is restarting is unavailable, not empty', () => {
  test('the failing station is named and its rows are not claimed to be zero', async () => {
    setAgentMap(OWNED, { ['agent000001']: 'Tony' });
    setTrainCallBackend((train) => {
      if (train === 'xmtp') return Promise.reject(new Error('train restarting'));
      return Promise.resolve({ result: { accounts: [{ id: 't0' }] } });
    });
    const { accounts, unavailable } = await gatherAccountsForAgents(new Set(['agent000001']));
    expect(unavailable).toContain('xmtp');
    expect(accounts['telegram-bot']).toHaveLength(1);
  });

  test('a station that really has no accounts is not reported unavailable', async () => {
    setAgentMap(OWNED, { ['agent000001']: 'Tony' });
    setTrainCallBackend((train) =>
      Promise.resolve({
        result: { accounts: train === 'telegram-bot' ? [{ id: 't0' }] : [] },
      }),
    );
    const { accounts, unavailable } = await gatherAccountsForAgents(new Set(['agent000001']));
    expect(unavailable).toEqual([]);
    expect(accounts.xmtp).toEqual([]);
    expect(accounts['telegram-bot']).toHaveLength(1);
  });
});
