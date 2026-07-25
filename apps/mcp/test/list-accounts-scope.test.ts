import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { scopeAccountsByAgent } from '../src/mcp/accounts.ts';
import { agentForAccount, setAgentMap } from '../src/db/agent-map.ts';

describe('scopeAccountsByAgent', () => {
  beforeEach(() =>
    setAgentMap({
      'xmtp/x0': 'tony',
      'discord/d0': 'tony',
      'telegram/t0': 'wan',
    }),
  );
  afterAll(() => setAgentMap({}));

  test('agentForAccount resolves the owning agent name', () => {
    expect(agentForAccount('xmtp', 'x0')).toBe('tony');
    expect(agentForAccount('telegram', 't0')).toBe('wan');
    expect(agentForAccount('xmtp', 'unknown')).toBeUndefined();
  });

  test('keeps only accounts owned by an allowed agent', () => {
    const byStation = {
      xmtp: [{ id: 'x0' }],
      discord: [{ id: 'd0' }],
      telegram: [{ id: 't0' }],
    };
    const scoped = scopeAccountsByAgent(byStation, new Set(['tony']));
    expect(scoped.xmtp).toEqual([{ id: 'x0' }]);
    expect(scoped.discord).toEqual([{ id: 'd0' }]);
    expect(scoped.telegram).toEqual([]);
  });

  test('drops accounts with no id or no mapped agent', () => {
    const byStation = {
      xmtp: [{ id: 'x0' }, { id: 'ghost' }, { owner: 'x' }],
    };
    const scoped = scopeAccountsByAgent(byStation, new Set(['tony']));
    expect(scoped.xmtp).toEqual([{ id: 'x0' }]);
  });

  test('an unmatched agent set yields empty stations', () => {
    const scoped = scopeAccountsByAgent({ xmtp: [{ id: 'x0' }] }, new Set(['nobody']));
    expect(scoped.xmtp).toEqual([]);
  });
});
