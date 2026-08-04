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
  test('accepts a positive decimal id', () => {
    expect(parseAgentId('1')).toBe(1);
    expect(parseAgentId('4242')).toBe(4242);
  });

  test('rejects anything that is not a plain positive integer', () => {
    for (const bad of ['', '0', '-1', '01', '1.0', '1e3', ' 1', '1 ', 'abc', '1;DROP', '99999999999'])
      expect(parseAgentId(bad)).toBeNull();
  });
});

describe('toAgentSummaries', () => {
  const OWNER = 11;
  const ROWS = [
    { id: 1, name: 'ada-bot', ownerId: OWNER },
    { id: 2, name: 'bob-bot', ownerId: 22 },
    { id: 5, name: 'legacy', ownerId: null },
  ];

  test('an owned agent carries its key value', () => {
    const out = toAgentSummaries(OWNER, ROWS, [
      { agentId: 1, name: 'default', key: 'mk_fake_ada' },
    ]);
    expect(out[0]).toEqual({
      id: 1,
      name: 'ada-bot',
      owned: true,
      keys: [{ name: 'default', key: 'mk_fake_ada' }],
    });
  });

  test('a granted operator row is listed by key name with a null value', () => {
    const out = toAgentSummaries(OWNER, ROWS, [{ agentId: 5, name: 'default' }]);
    expect(out[2]).toEqual({
      id: 5,
      name: 'legacy',
      owned: false,
      keys: [{ name: 'default', key: null }],
    });
  });

  test('a key value belonging to a row the caller does not own is dropped', () => {
    const out = toAgentSummaries(OWNER, ROWS, [
      { agentId: 2, name: 'default', key: 'mk_fake_bob' },
      { agentId: 5, name: 'default', key: 'mk_fake_legacy' },
    ]);
    expect(out.flatMap((a) => a.keys.map((k) => k.key))).toEqual([null, null]);
  });

  test('a null owner_id never matches a caller with no user row', () => {
    const out = toAgentSummaries(null, ROWS, [
      { agentId: 5, name: 'default', key: 'mk_fake_legacy' },
    ]);
    expect(out.every((a) => !a.owned)).toBe(true);
    expect(out[2]?.keys).toEqual([{ name: 'default', key: null }]);
  });

  test('an owner id never matches an operator row that has no owner at all', () => {
    const out = toAgentSummaries(OWNER, ROWS, [
      { agentId: 5, name: 'default', key: 'mk_fake_legacy' },
    ]);
    expect(out[2]?.owned).toBe(false);
    expect(out[2]?.keys[0]?.key).toBeNull();
  });

  test('keys are sorted by name so the list is stable across requests', () => {
    const out = toAgentSummaries(OWNER, ROWS, [
      { agentId: 1, name: 'zulu', key: 'mk_fake_z' },
      { agentId: 1, name: 'alpha', key: 'mk_fake_a' },
    ]);
    expect(out[0]?.keys.map((k) => k.name)).toEqual(['alpha', 'zulu']);
  });
});

describe('resolveUserId', () => {
  test('a first login inserts the row and uses the id it just got back', async () => {
    let lookups = 0;
    const id = await resolveUserId(
      () => Promise.resolve(7),
      () => {
        lookups += 1;
        return Promise.resolve(null);
      },
    );
    expect(id).toBe(7);
    expect(lookups).toBe(0);
  });

  test('a losing concurrent first login re-selects the winner id instead of failing', async () => {
    const id = await resolveUserId(
      () => Promise.resolve(undefined),
      () => Promise.resolve(7),
    );
    expect(id).toBe(7);
  });

  test('two concurrent first logins settle on ONE id and create ONE row', async () => {
    const table = new Map<string, number>();
    let nextId = 0;
    const insert = (email: string) => (): Promise<number | undefined> => {
      if (table.has(email)) return Promise.resolve(undefined);
      nextId += 1;
      table.set(email, nextId);
      return Promise.resolve(nextId);
    };
    const lookup = (email: string) => (): Promise<number | null> =>
      Promise.resolve(table.get(email) ?? null);
    const ids = await Promise.all(
      Array.from({ length: 8 }, () =>
        resolveUserId(insert('ada@lovelace.dev'), lookup('ada@lovelace.dev')),
      ),
    );
    expect(new Set(ids)).toEqual(new Set([1]));
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
