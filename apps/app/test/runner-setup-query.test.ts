import { afterEach, beforeEach, expect, test } from 'bun:test';
import { QueryObserver, type QueryClient } from '@tanstack/react-query';
import { clearAccount } from '@metro-labs/client/auth/account';
import { setCurrentServer } from '@metro-labs/client/auth/daemon';
import { configurePlatform, memoryKeyValue } from '@metro-labs/client/platform';
import { fetchClaudeSetup } from '@metro-labs/client/api/claude-box';
import { sdkSelectable } from '@metro-labs/client/api/runner';
import { installTestAccount } from '../../../packages/client/test/account-fixture.js';
import { boxKey, CLAUDE_SETUP_QUERY, makeQueryClient, refresh } from '../src/lib/queries.js';

const realFetch = globalThis.fetch;
let client: QueryClient;
let allowed: boolean;
let calls: string[];

beforeEach(() => {
  configurePlatform({ kv: memoryKeyValue(), tabKv: memoryKeyValue() });
  installTestAccount();
  setCurrentServer({ id: 'source00001', host: 'fixture.example' });
  client = makeQueryClient(() => undefined);
  calls = [];
  globalThis.fetch = Object.assign((input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    if (!url.endsWith('/api/claude/setup')) return Promise.reject(new Error('Unexpected request'));
    calls.push(url);
    return Promise.resolve(Response.json({ privacy: true, runner: 'cli', runnerAllowed: allowed, sdkOnLogin: false }));
  }, { preconnect: realFetch.preconnect });
});

afterEach(() => {
  client.clear();
  globalThis.fetch = realFetch;
  clearAccount();
  setCurrentServer(null);
});

for (const { name, prior, age } of [
  { name: 'a newly eligible route enables SDK even with a fresh cached refusal', prior: false, age: 0 },
  { name: 'a stale refusal is refreshed on returning to Harness', prior: false, age: 20_000 },
  { name: 'a newly ineligible route disables SDK instead of keeping cached permission', prior: true, age: 0 },
]) {
  test(name, async () => {
    const key = boxKey('claude-setup');
    allowed = prior;
    const before = await client.fetchQuery({ queryKey: key, queryFn: fetchClaudeSetup });
    expect(sdkSelectable(before)).toBe(prior);
    client.setQueryData(key, before, { updatedAt: Date.now() - age });
    allowed = !prior;
    await refresh(client, 'model');
    const observer = new QueryObserver(client, { ...CLAUDE_SETUP_QUERY, queryKey: key, queryFn: fetchClaudeSetup });
    const stop = observer.subscribe(() => undefined);
    try {
      await observer.getCurrentQuery().promise;
      expect(calls).toHaveLength(2);
      const after = observer.getCurrentResult().data;
      expect(after).toBeDefined();
      if (after === undefined) throw new Error('Missing setup');
      expect(sdkSelectable(after)).toBe(!prior);
    } finally {
      stop();
    }
  });
}
