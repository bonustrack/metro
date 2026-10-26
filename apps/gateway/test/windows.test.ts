import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { PGlite } from '@electric-sql/pglite';
import type { Database } from '@metro-labs/connectors/db/database';
import { forgetUsage, noteUsage, usageOf } from '@metro-labs/inference/usage';
import { WindowSaver } from '../src/windows.ts';
import { OWNER, PGLITE_START_MS, testDb } from './helpers.ts';

const CONN = 'conn0000001';
const EARLIER = '2026-10-26T01:00:00.000Z';
const LATER = '2026-10-26T01:05:00.000Z';
const RESET = '2026-10-26T05:00:00.000Z';

let held: { db: Database; client: PGlite };

beforeAll(async () => {
  held = await testDb();
}, PGLITE_START_MS);

beforeEach(async () => {
  forgetUsage();
  await held.client.exec('TRUNCATE "model_windows"');
});

afterAll(async () => {
  await held.client.close();
});

const saver = (): WindowSaver => {
  const one = new WindowSaver(() => held.db);
  one.seen(OWNER, CONN);
  return one;
};

describe('the usage windows both gateway machines share', () => {
  test('a machine adopts what the other saved, so a model near its limit is held on both', async () => {
    noteUsage(CONN, { windows: [{ label: '5-hour window', used: 0.97, resetAt: RESET, detail: null }], note: null, at: LATER });
    await saver().sync();
    forgetUsage();
    expect(usageOf(CONN)).toBeUndefined();
    await saver().load();
    expect(usageOf(CONN)).toEqual({ windows: [{ label: '5-hour window', used: expect.closeTo(0.97, 5) as number, resetAt: RESET, detail: null }], note: null, at: LATER });
  });

  test('a reading of its own that is newer is kept, and a connection this machine never served is not loaded', async () => {
    noteUsage(CONN, { windows: [{ label: '5-hour window', used: 0.2, resetAt: null, detail: null }], note: null, at: EARLIER });
    await saver().save();
    noteUsage(CONN, { windows: [{ label: '5-hour window', used: 0.5, resetAt: null, detail: null }], note: null, at: LATER });
    await saver().load();
    expect(usageOf(CONN)?.windows[0]?.used).toBe(0.5);
    forgetUsage();
    const stranger = new WindowSaver(() => held.db);
    stranger.seen(OWNER, 'conn0000002');
    await stranger.load();
    expect(usageOf(CONN)).toBeUndefined();
  });
});
