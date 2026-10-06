import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isRecord } from '@metro-labs/core/is-record';
import type { WAClient } from '../src/client-types.js';
import { accounts } from '../src/accounts.js';
import { makeHandleCall } from '../src/actions.js';
import { fixture } from './client-fixture.js';

const clients: WAClient[] = [];
let dir: string;
let previous: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'metro-wa-client-channels-'));
  previous = process.env.WHATSAPP_TOKEN_DIR;
  process.env.WHATSAPP_TOKEN_DIR = dir;
});
afterEach(async () => {
  for (const client of clients.splice(0)) await client.disconnect();
  accounts.clear();
  if (previous === undefined) delete process.env.WHATSAPP_TOKEN_DIR;
  else process.env.WHATSAPP_TOKEN_DIR = previous;
  rmSync(dir, { recursive: true, force: true });
});

test('the connected client discovers groups and persisted chats without inbound replay or sends', async () => {
  const f = await fixture(clients);
  let groupCalls = 0;
  f.sock.groupFetchAllParticipating = () => {
    groupCalls++;
    return Promise.resolve({ group: { id: '123@g.us', subject: 'Quiet group', owner: undefined, participants: [] } });
  };
  f.ev.emit('messaging-history.set', { chats: [{ id: '789@lid', name: 'Quiet DM' }], messages: [], contacts: [] });
  const page = await f.client.listChannels({});
  expect(page.channels.map((entry) => entry.name)).toEqual(['Quiet group', 'Quiet DM']);
  expect(groupCalls).toBe(1);
  expect(f.live).toEqual([]);
  expect(f.sent).toEqual([]);
  await f.client.disconnect();
  f.ev.emit('chats.upsert', [{ id: '888@lid', name: 'Too late' }]);
  const reopened = await fixture(clients);
  reopened.sock.groupFetchAllParticipating = () => Promise.resolve({});
  expect((await reopened.client.listChannels({})).channels.map((entry) => entry.id)).toEqual(['789@lid']);
  expect(reopened.live).toEqual([]);
  expect(reopened.sent).toEqual([]);
});

test('listChannels action requires an explicit known account before touching a socket', async () => {
  const f = await fixture(clients);
  accounts.set('fixture', f.client.account);
  let lookups = 0;
  f.sock.groupFetchAllParticipating = () => Promise.resolve({});
  const handle = makeHandleCall(() => { lookups++; return f.client; });
  const responses: unknown[] = [];
  const writer = spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    const parsed: unknown = JSON.parse(String(chunk));
    if (isRecord(parsed) && parsed.op === 'response') responses.push(parsed);
    return true;
  });
  try {
    await handle({ op: 'call', id: 'missing', action: 'listChannels', args: {} });
    await handle({ op: 'call', id: 'unknown', action: 'listChannels', args: { account: 'unknown' } });
    expect(lookups).toBe(0);
    await handle({ op: 'call', id: 'known', action: 'listChannels', args: { account: 'fixture' } });
  } finally {
    writer.mockRestore();
  }
  expect(responses[0]).toMatchObject({ id: 'missing', error: expect.stringContaining('requires an account') });
  expect(responses[1]).toMatchObject({ id: 'unknown', error: expect.stringContaining('unknown') });
  expect(responses[2]).toMatchObject({ id: 'known', result: { channels: [], capability: { supported: true, complete: false } } });
  expect(lookups).toBe(1);
});
