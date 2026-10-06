import { expect, spyOn, test } from 'bun:test';
import type { ChannelList } from '@metro-labs/core/stations/channel-directory';
import { accounts } from '../src/accounts.ts';
import { makeHandleCall } from '../src/actions.ts';
import type { UserClient } from '../src/client.ts';

function fixture(ids: number[]) {
  const state = { scans: 0 };
  const client = {
    async *iterDialogs(params: { pinned: string }) {
      state.scans++;
      if (params.pinned === 'exclude') {
        for (const id of ids) yield { peer: { id, type: 'user', displayName: `Quiet ${id}` } };
      }
    },
  };
  return { state, client: { tg: client } as unknown as UserClient };
}

test('discovery cursors cannot survive account removal or replacement under the same id', async () => {
  const account = 'discovery-lifecycle';
  const original = fixture([101, 102]);
  const replacement = fixture([201]);
  let active = original.client;
  let selections = 0;
  const handle = makeHandleCall(() => { selections++; return active; });
  const writes: string[] = [];
  const output = spyOn(process.stdout, 'write').mockImplementation((chunk) => { writes.push(String(chunk)); return true; });
  const call = async (args: Record<string, unknown>): Promise<{ result?: ChannelList; error?: string }> => {
    await handle({ op: 'call', id: 'lifecycle', action: 'listChannels', args: { account, ...args } });
    return JSON.parse(writes.at(-1) ?? '{}');
  };
  accounts.set(account, { id: account, session: 'original-fixture' });
  try {
    const first = await call({ limit: 1 });
    const cursor = first.result?.next_cursor;
    expect(cursor).toBeString();
    expect((await call({ cursor })).result?.channels.map(({ id }) => id)).toEqual(['102']);
    expect(original.state.scans).toBe(3);
    const selected = selections;
    accounts.delete(account);
    expect((await call({ cursor })).error).toContain('unknown account');
    expect(selections).toBe(selected);
    accounts.set(account, { id: account, session: 'replacement-fixture' });
    active = replacement.client;
    expect((await call({ cursor })).error).toContain('Invalid or expired channel cursor');
    expect(replacement.state.scans).toBe(0);
    expect((await call({})).result?.channels.map(({ id }) => id)).toEqual(['201']);
    expect(original.state.scans).toBe(3);
    expect(replacement.state.scans).toBe(3);
  } finally {
    accounts.delete(account);
    output.mockRestore();
  }
});
