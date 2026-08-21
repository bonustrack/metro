import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { attachAgentIds, scopeAccountsByAgent } from '../src/mcp/accounts.ts';
import { agentForLine, agentIdForAccount, setAgentMap } from '../src/db/agent-map.ts';

describe('scopeAccountsByAgent', () => {
  beforeEach(() =>
    setAgentMap(
      { 'xmtp/x0': 'agent000001', 'discord/d0': 'agent000001', 'telegram/t0': 'agent000002' },
      { ['agent000001']: 'tony', ['agent000002']: 'wan' },
    ),
  );
  afterAll(() => setAgentMap({}, {}));

  test('agentIdForAccount resolves the owning agent id', () => {
    expect(agentIdForAccount('xmtp', 'x0')).toBe('agent000001');
    expect(agentIdForAccount('telegram', 't0')).toBe('agent000002');
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
    const scoped = scopeAccountsByAgent(byStation, new Set(['agent000001']));
    expect(scoped.xmtp).toEqual([{ id: 'x0' }]);
    expect(scoped.discord).toEqual([{ id: 'd0' }]);
    expect(scoped.telegram).toEqual([]);
  });

  test('drops accounts with no id or no mapped agent', () => {
    const byStation = {
      xmtp: [{ id: 'x0' }, { id: 'ghost' }, { owner: 'x' }],
    };
    const scoped = scopeAccountsByAgent(byStation, new Set(['agent000001']));
    expect(scoped.xmtp).toEqual([{ id: 'x0' }]);
  });

  test('an unmatched agent set yields empty stations', () => {
    const scoped = scopeAccountsByAgent({ xmtp: [{ id: 'x0' }] }, new Set(['agent000099']));
    expect(scoped.xmtp).toEqual([]);
  });
});

describe('two agents with the same name, different owners', () => {
  beforeEach(() =>
    setAgentMap(
      { 'telegram/ada-tg': 'agent000007', 'telegram/bob-tg': 'agent000008' },
      { ['agent000007']: 'tony', ['agent000008']: 'tony' },
    ),
  );
  afterAll(() => setAgentMap({}, {}));

  test('each id sees only its own account', () => {
    const byStation = { telegram: [{ id: 'ada-tg' }, { id: 'bob-tg' }] };
    expect(scopeAccountsByAgent(byStation, new Set(['agent000007'])).telegram).toEqual([
      { id: 'ada-tg' },
    ]);
    expect(scopeAccountsByAgent(byStation, new Set(['agent000008'])).telegram).toEqual([
      { id: 'bob-tg' },
    ]);
  });

  test('the shared name is not a key — both accounts still report it', () => {
    expect(agentForLine('metro://telegram/ada-tg/c1')).toBe('tony');
    expect(agentForLine('metro://telegram/bob-tg/c1')).toBe('tony');
    expect(agentIdForAccount('telegram', 'ada-tg')).toBe('agent000007');
    expect(agentIdForAccount('telegram', 'bob-tg')).toBe('agent000008');
  });

  test('two accounts of the same station carry their own agent id', () => {
    const tagged = attachAgentIds({ telegram: [{ id: 'ada-tg' }, { id: 'bob-tg' }] });
    expect(tagged.telegram).toEqual([
      { id: 'ada-tg', agentId: 'agent000007' },
      { id: 'bob-tg', agentId: 'agent000008' },
    ]);
  });
});

describe('attachAgentIds', () => {
  beforeEach(() =>
    setAgentMap(
      { 'xmtp/x0': 'agent000001', 'discord/d0': 'agent000001', 'telegram/t0': 'agent000002' },
      { ['agent000001']: 'tony', ['agent000002']: 'wan' },
    ),
  );
  afterAll(() => setAgentMap({}, {}));

  test('stamps every account with the id of the agent it belongs to', () => {
    const tagged = attachAgentIds({
      xmtp: [{ id: 'x0', owner: 'a' }],
      discord: [{ id: 'd0' }],
      telegram: [{ id: 't0' }],
    });
    expect(tagged.xmtp).toEqual([{ id: 'x0', owner: 'a', agentId: 'agent000001' }]);
    expect(tagged.discord).toEqual([{ id: 'd0', agentId: 'agent000001' }]);
    expect(tagged.telegram).toEqual([{ id: 't0', agentId: 'agent000002' }]);
  });

  test('an account with no mapped agent or no id is passed through untouched', () => {
    const tagged = attachAgentIds({
      xmtp: [{ id: 'ghost' }, { owner: 'x' }, 'not-an-object'],
    });
    expect(tagged.xmtp).toEqual([{ id: 'ghost' }, { owner: 'x' }, 'not-an-object']);
  });

  test('an empty station stays empty', () => {
    expect(attachAgentIds({ line: [] })).toEqual({ line: [] });
  });

  test('the input accounts are not mutated', () => {
    const account = { id: 'x0' };
    attachAgentIds({ xmtp: [account] });
    expect(account).toEqual({ id: 'x0' });
  });
});
