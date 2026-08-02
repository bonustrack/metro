import { afterEach, describe, expect, test } from 'bun:test';
import {
  AgentAdminError,
  newApiKey,
  normalizeAgentName,
  normalizeEmail,
  parseAgentId,
  servesEveryAgent,
} from '../src/db/agent-admin.ts';

const PIN = process.env.METRO_AGENT;
afterEach(() => {
  if (PIN === undefined) delete process.env.METRO_AGENT;
  else process.env.METRO_AGENT = PIN;
});

describe('normalizeAgentName', () => {
  test('lowercases and trims a valid name', () => {
    expect(normalizeAgentName('  My-Agent_1 ')).toBe('my-agent_1');
  });

  test('accepts the shortest and longest allowed names', () => {
    expect(normalizeAgentName('ab')).toBe('ab');
    expect(normalizeAgentName('a'.repeat(32))).toBe('a'.repeat(32));
  });

  test('rejects names that could collide with scoping or shell quoting', () => {
    for (const bad of [
      '',
      'a',
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
