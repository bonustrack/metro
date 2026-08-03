import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { scopeAccountsByAgent } from '../src/mcp/accounts.ts';
import { agentForLine, agentIdForAccount, setAgentMap } from '../src/db/agent-map.ts';

describe('scopeAccountsByAgent', () => {
  beforeEach(() =>
    setAgentMap(
      { 'xmtp/x0': 1, 'discord/d0': 1, 'telegram/t0': 2 },
      { 1: 'tony', 2: 'wan' },
    ),
  );
  afterAll(() => setAgentMap({}, {}));

  test('agentIdForAccount resolves the owning agent id', () => {
    expect(agentIdForAccount('xmtp', 'x0')).toBe(1);
    expect(agentIdForAccount('telegram', 't0')).toBe(2);
    expect(agentIdForAccount('xmtp', 'unknown')).toBeUndefined();
  });

  test('agentForLine still resolves the display name through the id', () => {
    expect(agentForLine('metro://xmtp/x0/conv1')).toBe('tony');
    expect(agentForLine('metro://telegram/t0/chat1')).toBe('wan');
    expect(agentForLine('metro://xmtp/unknown/conv1')).toBeUndefined();
  });

  test('keeps only accounts owned by an allowed agent', () => {
    const byStation = {
      xmtp: [{ id: 'x0' }],
      discord: [{ id: 'd0' }],
      telegram: [{ id: 't0' }],
    };
    const scoped = scopeAccountsByAgent(byStation, new Set([1]));
    expect(scoped.xmtp).toEqual([{ id: 'x0' }]);
    expect(scoped.discord).toEqual([{ id: 'd0' }]);
    expect(scoped.telegram).toEqual([]);
  });

  test('drops accounts with no id or no mapped agent', () => {
    const byStation = {
      xmtp: [{ id: 'x0' }, { id: 'ghost' }, { owner: 'x' }],
    };
    const scoped = scopeAccountsByAgent(byStation, new Set([1]));
    expect(scoped.xmtp).toEqual([{ id: 'x0' }]);
  });

  test('an unmatched agent set yields empty stations', () => {
    const scoped = scopeAccountsByAgent({ xmtp: [{ id: 'x0' }] }, new Set([99]));
    expect(scoped.xmtp).toEqual([]);
  });
});

describe('two agents with the same name, different owners', () => {
  beforeEach(() =>
    setAgentMap(
      { 'telegram/ada-tg': 7, 'telegram/bob-tg': 8 },
      { 7: 'tony', 8: 'tony' },
    ),
  );
  afterAll(() => setAgentMap({}, {}));

  test('each id sees only its own account', () => {
    const byStation = { telegram: [{ id: 'ada-tg' }, { id: 'bob-tg' }] };
    expect(scopeAccountsByAgent(byStation, new Set([7])).telegram).toEqual([
      { id: 'ada-tg' },
    ]);
    expect(scopeAccountsByAgent(byStation, new Set([8])).telegram).toEqual([
      { id: 'bob-tg' },
    ]);
  });

  test('the shared name is not a key — both accounts still report it', () => {
    expect(agentForLine('metro://telegram/ada-tg/c1')).toBe('tony');
    expect(agentForLine('metro://telegram/bob-tg/c1')).toBe('tony');
    expect(agentIdForAccount('telegram', 'ada-tg')).toBe(7);
    expect(agentIdForAccount('telegram', 'bob-tg')).toBe(8);
  });
});
