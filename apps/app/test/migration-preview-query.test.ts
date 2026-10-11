import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { clearAccount } from '@metro-labs/client/auth/account';
import { setCurrentServer } from '@metro-labs/client/auth/daemon';
import { configurePlatform, memoryKeyValue } from '@metro-labs/client/platform';
import { fetchMigrationPreview, type MigrationPlan } from '@metro-labs/client/api/connector-migration';
import { installTestAccount, TEST_ORGANIZATION } from '../../../packages/client/test/account-fixture.js';
import { MIGRATION_PREVIEW_QUERY } from '../src/lib/migration-preview-query.js';

const realFetch = globalThis.fetch;
const KEY = ['connectors', 'https://source.example', 'migration-preview', 'test'];
let client: QueryClient;
let tools: Record<string, string>;

beforeEach(() => {
  configurePlatform({ kv: memoryKeyValue(), tabKv: memoryKeyValue() });
  installTestAccount();
  setCurrentServer({ id: 'source00001', host: 'source.example' });
  client = new QueryClient();
  tools = Object.fromEntries([['__proto__', 'deny'], ['read_tool', 'allow']]);
  globalThis.fetch = Object.assign((input: string | URL | Request): Promise<Response> => {
    if (String(input).endsWith('/migration-preview')) return Promise.resolve(Response.json({
      enabled: true, enrolled: true, agentId: 'source00001', owner: TEST_ORGANIZATION, liveEnabled: false,
      connectors: [{ id: 'conn0000001', name: 'Fixture', auth: 'none', origin: 'https://fixture.example', policy: { tools }, policySupported: false, issues: ['custom_policy'] }],
    }));
    return Promise.resolve(Response.json({ admin: true, connectors: [] }));
  }, { preconnect: realFetch.preconnect });
});

afterEach(() => {
  client.clear();
  globalThis.fetch = realFetch;
  clearAccount();
  setCurrentServer(null);
});

const cachedPolicy = (): Record<string, string> | undefined => client.getQueryData<MigrationPlan>(KEY)?.rows[0]?.source.policy.tools;

describe('migration preview query policy preservation', () => {
  test('a mounted preview keeps a changed own __proto__ rule across a refetch', async () => {
    const observer = new QueryObserver(client, { ...MIGRATION_PREVIEW_QUERY, queryKey: KEY, queryFn: fetchMigrationPreview });
    const stop = observer.subscribe(() => undefined);
    try {
      await observer.refetch({ throwOnError: true });
      expect(Object.entries(cachedPolicy() ?? {})).toEqual([['__proto__', 'deny'], ['read_tool', 'allow']]);
      tools = Object.fromEntries([['__proto__', 'ask'], ['read_tool', 'allow']]);
      await observer.refetch({ throwOnError: true });
      expect(Object.hasOwn(cachedPolicy() ?? {}, '__proto__')).toBe(true);
      expect(Object.entries(cachedPolicy() ?? {})).toEqual([['__proto__', 'ask'], ['read_tool', 'allow']]);
    } finally {
      stop();
    }
  });

  test('a refetch removes obsolete tool rules instead of retaining cached policy', async () => {
    const observer = new QueryObserver(client, { ...MIGRATION_PREVIEW_QUERY, queryKey: KEY, queryFn: fetchMigrationPreview });
    const stop = observer.subscribe(() => undefined);
    try {
      await observer.refetch({ throwOnError: true });
      tools = { read_tool: 'deny' };
      await observer.refetch({ throwOnError: true });
      expect(Object.entries(cachedPolicy() ?? {})).toEqual([['read_tool', 'deny']]);
      expect(Object.hasOwn(cachedPolicy() ?? {}, '__proto__')).toBe(false);
    } finally {
      stop();
    }
  });
});
