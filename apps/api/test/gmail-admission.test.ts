import { describe, expect, test } from 'bun:test';
import { gmailStartAdmission } from '../src/gmail/admission.js';
import { AGENT, HOST, SESSION, START, gmailFixture } from './gmail-fake.js';

const WINDOW_MS = 600_000;

describe('managed Gmail start admission', () => {
  test('a concurrent same-user flood cannot consume another user\'s pending state or flood authorization', async () => {
    const f = gmailFixture();
    const victim = await f.start();
    const flooder = { ...SESSION, userId: 'user_flooder' };
    const attempts = await Promise.allSettled(Array.from({ length: 100 }, () => f.start({}, flooder)));
    expect(attempts.filter((entry) => entry.status === 'fulfilled')).toHaveLength(5);
    const refused = attempts.filter((entry) => entry.status === 'rejected');
    expect(refused).toHaveLength(95);
    for (const entry of refused) expect(entry.reason).toMatchObject({ status: 429 });
    expect(f.states.size(f.state.now)).toBe(6);
    expect(f.state.allowedChecks).toHaveLength(6);
    expect(f.state.requests).toHaveLength(0);
    await expect(f.exchange(victim.state)).resolves.toMatchObject({ accountEmail: START.mailbox });
  });

  test('cancellation, another session, box or organization cannot reset a user\'s budget', async () => {
    const f = gmailFixture();
    for (let i = 0; i < 5; i++) {
      const { state } = await f.start();
      f.broker.cancel(SESSION, { state, host: HOST, agentId: AGENT });
    }
    expect(f.states.size(f.state.now)).toBe(0);
    await expect(f.start({}, { ...SESSION, sessionId: 'session_other' })).rejects.toMatchObject({ status: 429 });
    await expect(f.start({}, { ...SESSION, organization: 'org_01OTHERORG0000' })).rejects.toMatchObject({ status: 429 });
    await expect(f.start({ host: 'other.tail1234.ts.net', agentId: 'other000001' })).rejects.toMatchObject({ status: 429 });
    expect(f.state.allowedChecks).toHaveLength(5);
    await expect(f.start({}, { ...SESSION, userId: 'user_other' })).resolves.toHaveProperty('state');
  });

  test('denied authorization attempts count and the rolling window frees only expired attempts', async () => {
    const f = gmailFixture();
    const startedAt = f.state.now;
    f.state.allowed = false;
    for (let i = 0; i < 5; i++) {
      f.state.now = startedAt + i * 1000;
      await expect(f.start()).rejects.toMatchObject({ status: 403 });
    }
    f.state.allowed = true;
    f.state.now = startedAt + WINDOW_MS - 1;
    await expect(f.start()).rejects.toMatchObject({ status: 429 });
    expect(f.state.allowedChecks).toHaveLength(5);
    f.state.now++;
    await expect(f.start()).resolves.toHaveProperty('state');
    await expect(f.start()).rejects.toMatchObject({ status: 429 });
    f.state.now += 1000;
    await expect(f.start()).resolves.toHaveProperty('state');
  });

  test('a full shared store rejects concurrent starts without evicting live unrelated tickets', async () => {
    const f = gmailFixture();
    const victim = await f.start();
    for (let i = 0; i < 998; i++) await f.start({}, { ...SESSION, userId: `user_fill_${String(i)}` });
    const race = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => f.start({}, {
      ...SESSION, userId: `user_race_${String(i)}`,
    })));
    expect(race.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
    const refused = race.filter((entry) => entry.status === 'rejected');
    expect(refused).toHaveLength(19);
    for (const entry of refused) expect(entry.reason).toMatchObject({ status: 503 });
    expect(f.states.size(f.state.now)).toBe(1000);
    expect(f.states.peek(victim.state, f.state.now)).toMatchObject({ userId: SESSION.userId });
    expect(f.state.requests).toHaveLength(0);
    await expect(f.exchange(victim.state)).resolves.toMatchObject({ accountEmail: START.mailbox });
    await expect(f.start({}, { ...SESSION, userId: 'user_released_slot' })).resolves.toHaveProperty('state');
    expect(f.states.size(f.state.now)).toBe(1000);
    f.state.now += WINDOW_MS;
    await expect(f.start()).resolves.toHaveProperty('state');
    expect(f.states.size(f.state.now)).toBe(1);
  });

  test('tracked actor capacity refuses new actors instead of forgetting another actor\'s budget', () => {
    const admit = gmailStartAdmission();
    const now = 1000;
    for (let i = 0; i < 5; i++) admit(SESSION.userId, now);
    for (let i = 1; i < 5000; i++) admit(`user_${String(i)}`, now);
    expect(() => admit('user_overflow', now)).toThrow('busy');
    expect(() => admit(SESSION.userId, now)).toThrow('Too many');
    expect(() => admit('user_1', now)).not.toThrow();
    expect(() => admit('user_overflow', now + WINDOW_MS - 1)).toThrow('busy');
    expect(() => admit('user_overflow', now + WINDOW_MS)).not.toThrow();
    expect(() => admit(SESSION.userId, now + WINDOW_MS)).not.toThrow();
  });
});
