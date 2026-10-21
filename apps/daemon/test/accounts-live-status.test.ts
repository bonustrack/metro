import { describe, expect, test } from 'bun:test';
import { setTrainCallBackend } from '../src/stations/train-call.ts';
import { gatherAccountsForAgents } from '../src/mcp/accounts.ts';
import { setAgentMap } from '../src/agents/map.ts';

const OWNED = { 'whatsapp/w1': 'agent000001', 'telegram-bot/t0': 'agent000001' };
const LOGGED_OUT = { state: 'logged_out', reason: 'WhatsApp removed this linked device.', since: 1_800_000_000_000 };

describe('the live state of a channel', () => {
  test('a station that reports its state passes it on, checked; any other station never claims one', async () => {
    setAgentMap(OWNED, { ['agent000001']: 'Lisa' });
    setTrainCallBackend((train) =>
      Promise.resolve({
        result: {
          accounts: train === 'whatsapp'
            ? [{ id: 'w1', handle: '+447700900123', status: LOGGED_OUT }]
            : [{ id: 't0', status: { state: 'connected', since: 1 } }],
        },
      }),
    );
    const { accounts } = await gatherAccountsForAgents(new Set(['agent000001']));
    expect(accounts.whatsapp).toEqual([{ id: 'w1', handle: '+447700900123', status: LOGGED_OUT, agentId: 'agent000001' }]);
    expect(accounts['telegram-bot']).toEqual([{ id: 't0', agentId: 'agent000001' }]);
  });

  test('a state the daemon cannot read is dropped, never shown as connected', async () => {
    setAgentMap(OWNED, { ['agent000001']: 'Lisa' });
    setTrainCallBackend((train) =>
      Promise.resolve({ result: { accounts: train === 'whatsapp' ? [{ id: 'w1', status: { state: 'fine' } }] : [] } }),
    );
    const { accounts } = await gatherAccountsForAgents(new Set(['agent000001']));
    expect(accounts.whatsapp).toEqual([{ id: 'w1', agentId: 'agent000001' }]);
  });

  test('a train that does not answer in time is unavailable, so its state is unknown rather than an old value', async () => {
    setAgentMap(OWNED, { ['agent000001']: 'Lisa' });
    setTrainCallBackend((train) =>
      train === 'whatsapp'
        ? new Promise(() => undefined)
        : Promise.resolve({ result: { accounts: [{ id: 't0' }] } }),
    );
    const started = Date.now();
    const { accounts, unavailable } = await gatherAccountsForAgents(new Set(['agent000001']));
    expect(Date.now() - started).toBeLessThan(7_000);
    expect(unavailable).toEqual(['whatsapp']);
    expect(accounts.whatsapp).toEqual([{ id: 'w1', agentId: 'agent000001' }]);
  }, 10_000);
});
