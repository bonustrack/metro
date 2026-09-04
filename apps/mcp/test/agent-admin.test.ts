import { describe, expect, test } from 'bun:test';
import { AgentAdminError, newApiKey, normalizeAgentName } from '../src/db/agent-admin.ts';
import { parseId } from '../src/db/ids.ts';

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
    expect(parseId('agent000001')).toBe('agent000001');
    expect(parseId('aB3-_xYz9Qw')).toBe('aB3-_xYz9Qw');
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
      expect(parseId(bad)).toBeNull();
  });
});
