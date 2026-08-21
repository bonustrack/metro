import { afterEach, describe, expect, test } from 'bun:test';
import {
  AgentAdminError,
  newApiKey,
  normalizeAgentName,
  normalizeEmail,
  parseAgentId,
  resolveUserId,
  servesEveryAgent,
  toAgentSummaries,
} from '../src/db/agent-admin.ts';

const PIN = process.env.METRO_AGENT;
afterEach(() => {
  if (PIN === undefined) delete process.env.METRO_AGENT;
  else process.env.METRO_AGENT = PIN;
});

describe('normalizeAgentName', () => {
  test('trims but keeps the casing the person chose', () => {
    expect(normalizeAgentName('  My-Agent_1 ')).toBe('My-Agent_1');
    expect(normalizeAgentName('Lisa')).toBe('Lisa');
    expect(normalizeAgentName('TONY')).toBe('TONY');
  });

  test('two names differing only in case stay two different strings', () => {
    expect(normalizeAgentName('lisa')).not.toBe(normalizeAgentName('Lisa'));
  });

  test('accepts the shortest and longest allowed names', () => {
    expect(normalizeAgentName('ab')).toBe('ab');
    expect(normalizeAgentName('a'.repeat(32))).toBe('a'.repeat(32));
    expect(normalizeAgentName('A'.repeat(32))).toBe('A'.repeat(32));
  });

  test('rejects names that could collide with scoping or shell quoting', () => {
    for (const bad of [
      '',
      'a',
      'A',
      'a'.repeat(33),
      '-leading',
      '_leading',
      'has space',
      'has/slash',
      'has"quote',
      'has;semi',
      'métro',
      42,
      null,
      undefined,
    ])
      expect(() => normalizeAgentName(bad)).toThrow(AgentAdminError);
  });

  test('a rejected name carries a 400 status', () => {
    try {
      normalizeAgentName('!!');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(AgentAdminError);
      expect((e as AgentAdminError).status).toBe(400);
    }
  });
});

describe('normalizeEmail', () => {
  test('trims and lowercases so ownership compares case-insensitively', () => {
    expect(normalizeEmail(' Fabien@BonusTrack.co ')).toBe('fabien@bonustrack.co');
  });
});

describe('newApiKey', () => {
  test('is prefixed, url-safe, and long enough to be unguessable', () => {
    const key = newApiKey();
    expect(key.startsWith('mk_')).toBe(true);
    expect(/^mk_[A-Za-z0-9_-]{43}$/.test(key)).toBe(true);
  });

  test('never contains a dot, so it cannot be mistaken for a session JWT', () => {
    for (let i = 0; i < 50; i += 1) expect(newApiKey().includes('.')).toBe(false);
  });

  test('does not repeat', () => {
    const seen = new Set(Array.from({ length: 200 }, () => newApiKey()));
    expect(seen.size).toBe(200);
  });
});

describe('parseAgentId', () => {
  test('accepts an id of exactly 11 base64url characters', () => {
    expect(parseAgentId('agent000001')).toBe('agent000001');
    expect(parseAgentId('aB3-_xYz9Qw')).toBe('aB3-_xYz9Qw');
  });

  test('rejects anything that is not one', () => {
    for (const bad of [
      '',
      '1',
      'agent00000',
      'agent0000012',
      'agent00000.',
      'agent00000+',
      ' agent00001',
      'agent00001 ',
      "agent'DROP",
      '-gent000001',
      '_gent000001',
    ])
      expect(parseAgentId(bad)).toBeNull();
  });
});

describe('toAgentSummaries', () => {
  const OWNER = 'user0000011';
  const ROWS = [
    { id: 'agent000001', name: 'ada-bot', ownerId: OWNER },
    { id: 'agent000002', name: 'bob-bot', ownerId: 'user0000022' },
    { id: 'agent000005', name: 'legacy', ownerId: null },
  ];

  test('an owned agent carries its key value', () => {
    const out = toAgentSummaries(OWNER, ROWS, [{ agentId: 'agent000001', key: 'mk_fake_ada' }]);
    expect(out[0]).toEqual({
      id: 'agent000001',
      name: 'ada-bot',
      owned: true,
      key: 'mk_fake_ada',
    });
  });

  test('an owned agent with no key at all is served a null key', () => {
    const out = toAgentSummaries(OWNER, ROWS, [{ agentId: 'agent000001', key: null }]);
    expect(out[0]).toEqual({ id: 'agent000001', name: 'ada-bot', owned: true, key: null });
  });

  test('a granted operator row is listed with a null key', () => {
    const out = toAgentSummaries(OWNER, ROWS, []);
    expect(out[2]).toEqual({ id: 'agent000005', name: 'legacy', owned: false, key: null });
  });

  test('a key value belonging to a row the caller does not own is dropped', () => {
    const out = toAgentSummaries(OWNER, ROWS, [
      { agentId: 'agent000002', key: 'mk_fake_bob' },
      { agentId: 'agent000005', key: 'mk_fake_legacy' },
    ]);
    expect(out.map((a) => a.key)).toEqual([null, null, null]);
  });

  test('a null owner_id never matches a caller with no user row', () => {
    const out = toAgentSummaries(null, ROWS, [{ agentId: 'agent000005', key: 'mk_fake_legacy' }]);
    expect(out.every((a) => !a.owned)).toBe(true);
    expect(out.map((a) => a.key)).toEqual([null, null, null]);
  });

  test('an owner id never matches an operator row that has no owner at all', () => {
    const out = toAgentSummaries(OWNER, ROWS, [{ agentId: 'agent000005', key: 'mk_fake_legacy' }]);
    expect(out[2]?.owned).toBe(false);
    expect(out[2]?.key).toBeNull();
  });

  test('every agent carries exactly one key field, never a list', () => {
    const out = toAgentSummaries(OWNER, ROWS, [{ agentId: 'agent000001', key: 'mk_fake_ada' }]);
    expect(Object.keys(out[0] ?? {}).sort()).toEqual(['id', 'key', 'name', 'owned']);
  });
});

describe('resolveUserId', () => {
  test('a first login inserts the row and uses the id it just got back', async () => {
    let lookups = 0;
    const id = await resolveUserId(
      () => Promise.resolve('user0000007'),
      () => {
        lookups += 1;
        return Promise.resolve(null);
      },
    );
    expect(id).toBe('user0000007');
    expect(lookups).toBe(0);
  });

  test('a losing concurrent first login re-selects the winner id instead of failing', async () => {
    const id = await resolveUserId(
      () => Promise.resolve(undefined),
      () => Promise.resolve('user0000007'),
    );
    expect(id).toBe('user0000007');
  });

  test('two concurrent first logins settle on ONE id and create ONE row', async () => {
    const table = new Map<string, string>();
    let nextId = 0;
    const insert = (email: string) => (): Promise<string | undefined> => {
      if (table.has(email)) return Promise.resolve(undefined);
      nextId += 1;
      table.set(email, `user${String(nextId).padStart(7, '0')}`);
      return Promise.resolve(table.get(email));
    };
    const lookup = (email: string) => (): Promise<string | null> =>
      Promise.resolve(table.get(email) ?? null);
    const ids = await Promise.all(
      Array.from({ length: 8 }, () =>
        resolveUserId(insert('ada@lovelace.dev'), lookup('ada@lovelace.dev')),
      ),
    );
    expect(new Set(ids)).toEqual(new Set(['user0000001']));
    expect(table.size).toBe(1);
  });

  test('an insert that conflicts against a row nobody can find is a 500, never a second row', async () => {
    try {
      await resolveUserId(
        () => Promise.resolve(undefined),
        () => Promise.resolve(null),
      );
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(AgentAdminError);
      expect((e as AgentAdminError).status).toBe(500);
    }
  });
});

describe('servesEveryAgent', () => {
  test('an unpinned daemon serves every agent, so a fresh key is live immediately', () => {
    delete process.env.METRO_AGENT;
    expect(servesEveryAgent()).toBe(true);
    process.env.METRO_AGENT = '   ';
    expect(servesEveryAgent()).toBe(true);
  });

  test('a METRO_AGENT-pinned daemon never registers another agent key, before or after restart', () => {
    process.env.METRO_AGENT = '1';
    expect(servesEveryAgent()).toBe(false);
  });
});
