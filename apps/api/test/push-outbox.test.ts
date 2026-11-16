import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { log } from '@metro-labs/core/log';
import type { FetchLike } from '@metro-labs/core/stations/oauth';
import { claimPushes, PUSH_ATTEMPTS_MAX, PUSH_KEEP_MS, queuePush, type PushRequest } from '@metro-labs/connectors/db/push-outbox';
import { dropPushTokens, pushTokensOf, registerPushDevice } from '../src/db/push-devices.ts';
import { pushOutbox } from '../src/db/schema.ts';
import { pruneOutbox, RETRY_MS, runOutbox, type OutboxDeps } from '../src/push/outbox.ts';
import { PushSender } from '../src/push/sender.ts';
import { TEST_OWNER, TEST_STRANGER } from './identity-helper.ts';
import { PGLITE_START_MS, PGLITE_STEP_MS, testDb, type TestDb } from './pglite-db.ts';

const NOW = Date.parse('2026-11-15T09:00:00.000Z');
const ALICE = 'user_01ALICE';
const BOB = 'user_01BOB';
const ALICE_PHONE = 'ExponentPushToken[alicePhone0001]';
const BOB_PHONE = 'ExponentPushToken[bobPhone000002]';

let held: TestDb;
let now = NOW;
let expoStatus = 200;
let gone = new Set<string>();
let membersFail = false;
let sent: Record<string, unknown>[][] = [];

const expo: FetchLike = async (_url, init) => {
  const messages = JSON.parse(String(init?.body)) as Record<string, unknown>[];
  sent.push(messages);
  if (expoStatus !== 200) return new Response('{}', { status: expoStatus });
  return Response.json({ data: messages.map((message) => (gone.has(String(message.to)) ? { status: 'error', details: { error: 'DeviceNotRegistered' } } : { status: 'ok', id: 'ticket' })) });
};

function deps(): OutboxDeps {
  const sender = new PushSender({
    fetch: expo,
    accessToken: null,
    members: async (owner) => {
      if (membersFail) throw new Error('the members could not be read');
      return owner === TEST_OWNER ? [ALICE, BOB] : [];
    },
    devices: { tokensOf: (users) => pushTokensOf(held.db, users), drop: (tokens) => dropPushTokens(held.db, tokens) },
    now: () => now,
  });
  return { db: () => held.db, sender, now: () => now };
}

const request = (approval: string, owner = TEST_OWNER): PushRequest => ({
  owner,
  agent: 'agent000001',
  approval,
  title: 'Emma needs your approval',
  body: 'Update page on Notion',
  url: `https://metro.box/#/${owner}/agent000001/approvals/${approval}`,
});

const rowOf = async (approval: string) => (await held.db.select().from(pushOutbox).where(eq(pushOutbox.approval, approval)))[0];
const messages = (): Record<string, unknown>[] => sent.flat();

beforeAll(async () => {
  held = await testDb();
}, PGLITE_START_MS);

beforeEach(async () => {
  await held.reset();
  now = NOW;
  expoStatus = 200;
  gone = new Set();
  membersFail = false;
  sent = [];
  await registerPushDevice(held.db, { user: ALICE, token: ALICE_PHONE, platform: 'android', now });
  await registerPushDevice(held.db, { user: BOB, token: BOB_PHONE, platform: 'android', now });
}, PGLITE_STEP_MS);

afterAll(async () => {
  await held.close();
});

describe('the push outbox', () => {
  test('one row per approval of an agent, whoever asks to queue it again', async () => {
    expect(await queuePush(held.db, request('abcde'), now)).toBe(true);
    expect(await queuePush(held.db, request('abcde'), now + 1)).toBe(false);
    expect(await queuePush(held.db, request('bcdef'), now)).toBe(true);
    expect(await held.db.$count(pushOutbox)).toBe(2);
  });

  test('the loop claims a waiting row, sends it to every member device and marks it sent', async () => {
    await queuePush(held.db, request('abcde'), now);
    expect(await runOutbox(deps())).toBe(1);
    expect(messages().map((message) => message.to)).toEqual([ALICE_PHONE, BOB_PHONE]);
    expect(messages()[0]).toMatchObject({ title: 'Emma needs your approval', body: 'Update page on Notion', data: { url: `https://metro.box/#/${TEST_OWNER}/agent000001/approvals/abcde` }, channelId: 'approvals' });
    expect(await rowOf('abcde')).toMatchObject({ sentAt: NOW, attempts: 1 });
    expect(await runOutbox(deps())).toBe(0);
    expect(sent).toHaveLength(1);
  });

  test('an organization whose members have no phone is done, not retried', async () => {
    await queuePush(held.db, request('abcde', TEST_STRANGER), now);
    expect(await runOutbox(deps())).toBe(1);
    expect(sent).toEqual([]);
    expect(await rowOf('abcde')).toMatchObject({ sentAt: NOW, attempts: 1 });
  });

  test('two machines claiming at once never send a row twice', async () => {
    for (const id of ['abcde', 'bcdef', 'cdefg', 'defgh']) await queuePush(held.db, request(id), now);
    const [first, second] = await Promise.all([claimPushes(held.db, now, 20), claimPushes(held.db, now, 20)]);
    expect((first?.length ?? 0) + (second?.length ?? 0)).toBe(4);
    await held.db.update(pushOutbox).set({ sentAt: null, attempts: 0 });
    await Promise.all([runOutbox(deps()), runOutbox(deps()), runOutbox(deps())]);
    expect(messages()).toHaveLength(8);
    expect(new Set(messages().map((message) => `${String(message.to)} ${JSON.stringify(message.data)}`)).size).toBe(8);
  });

  test('a failure is retried later with a growing pause, then given up after the last attempt', async () => {
    const warns: string[] = [];
    const warn = spyOn(log, 'warn').mockImplementation((...args: unknown[]) => { warns.push(JSON.stringify(args)); });
    try {
      expoStatus = 503;
      await queuePush(held.db, request('abcde'), now);
      expect(await runOutbox(deps())).toBe(1);
      expect(await rowOf('abcde')).toMatchObject({ sentAt: null, attempts: 1, nextAt: NOW + (RETRY_MS[0] ?? 0) });
      expect(await runOutbox(deps())).toBe(0);
      for (let attempt = 2; attempt <= PUSH_ATTEMPTS_MAX; attempt += 1) {
        now = (await rowOf('abcde'))?.nextAt ?? now;
        expect(await runOutbox(deps())).toBe(1);
      }
      expect(await rowOf('abcde')).toMatchObject({ sentAt: null, attempts: PUSH_ATTEMPTS_MAX });
      now += 60 * 60_000;
      expect(await runOutbox(deps())).toBe(0);
      expect(sent).toHaveLength(PUSH_ATTEMPTS_MAX);
    } finally {
      warn.mockRestore();
    }
    expect(warns.join('\n')).toContain('push: notification given up');
    for (const secret of [ALICE_PHONE, BOB_PHONE, 'Emma needs', 'Update page', 'metro.box/#']) expect(warns.join('\n')).not.toContain(secret);
  });

  test('a failed read of the members is retried and a later attempt sends', async () => {
    membersFail = true;
    await queuePush(held.db, request('abcde'), now);
    await runOutbox(deps());
    expect(await rowOf('abcde')).toMatchObject({ sentAt: null, attempts: 1 });
    membersFail = false;
    now += RETRY_MS[0] ?? 0;
    expect(await runOutbox(deps())).toBe(1);
    expect(await rowOf('abcde')).toMatchObject({ sentAt: now, attempts: 2 });
    expect(messages()).toHaveLength(2);
  });

  test('a device Expo says is gone is dropped, and the row still counts as sent', async () => {
    gone = new Set([BOB_PHONE]);
    await queuePush(held.db, request('abcde'), now);
    await runOutbox(deps());
    expect(await pushTokensOf(held.db, [ALICE, BOB])).toEqual([ALICE_PHONE]);
    expect(await rowOf('abcde')).toMatchObject({ sentAt: NOW });
  });

  test('rows older than a day go, sent, given up or still waiting', async () => {
    await queuePush(held.db, request('abcde'), now - PUSH_KEEP_MS - 1);
    await queuePush(held.db, request('bcdef'), now - PUSH_KEEP_MS - 1);
    await held.db.update(pushOutbox).set({ sentAt: now - PUSH_KEEP_MS }).where(eq(pushOutbox.approval, 'abcde'));
    await queuePush(held.db, request('cdefg'), now - 1000);
    expect(await pruneOutbox({ db: () => held.db, now: () => now })).toBe(2);
    expect((await held.db.select().from(pushOutbox)).map((row) => row.approval)).toEqual(['cdefg']);
  });
});
