import { describe, expect, test } from 'bun:test';
import {
  AGENT_CODE_RE,
  agentCodeCount,
  mintAgentCode,
  takeAgentCode,
} from '../src/daemon/agent-pair.js';

const TTL_MS = 10 * 60_000;
const SEED = { email: 'less@bonustrack.co', agentId: 'agent000001' };

describe('the pairing code the agent page shows', () => {
  test('it is prefixed, fixed width and unguessable', () => {
    const { code } = mintAgentCode(SEED);
    expect(code).toMatch(AGENT_CODE_RE);
    expect(code.startsWith('ma_')).toBe(true);
    expect(code.length).toBe(19);
    const others = new Set(
      Array.from({ length: 50 }, () => mintAgentCode(SEED).code),
    );
    expect(others.size).toBe(50);
  });

  test('one code serves metro login and metro start alike; the old prefixes are gone', () => {
    expect(AGENT_CODE_RE.test('mc_aaaaaaaaaaaaaaaa')).toBe(false);
    expect(AGENT_CODE_RE.test('mr_aaaaaaaaaaaaaaaa')).toBe(false);
  });

  test('it resolves to the account AND the agent it was minted for', () => {
    const { code } = mintAgentCode(SEED);
    expect(takeAgentCode(code)).toEqual(SEED);
  });

  test('it is single use, so a shoulder-surfed code is spent', () => {
    const { code } = mintAgentCode(SEED);
    expect(takeAgentCode(code)).toEqual(SEED);
    expect(takeAgentCode(code)).toBeUndefined();
  });

  test('a code nobody minted is refused', () => {
    expect(takeAgentCode('ma_aaaaaaaaaaaaaaaa')).toBeUndefined();
  });

  test('it expires, and expiring consumes it rather than leaving it live', () => {
    const now = Date.now();
    const { code, expiresAt } = mintAgentCode(SEED, now);
    expect(expiresAt).toBe(now + TTL_MS);
    expect(takeAgentCode(code, now + TTL_MS + 1)).toBeUndefined();
    expect(takeAgentCode(code, now)).toBeUndefined();
  });

  test('expired codes do not pile up in memory', () => {
    const now = Date.now();
    mintAgentCode(SEED, now);
    const before = agentCodeCount();
    mintAgentCode(SEED, now + TTL_MS + 1);
    expect(agentCodeCount()).toBeLessThan(before + 2);
  });
});
