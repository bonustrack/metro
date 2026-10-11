import { afterEach, beforeEach, expect, test } from 'bun:test';
import { addOrgConnector, fetchOrgConnectors, replaceOrgConnectorKey } from '../src/api/org-connectors.js';
import { clearAccount, storeAccount } from '../src/auth/account.js';
import { configurePlatform, memoryKeyValue } from '../src/platform.js';
import { installTestAccount, testToken } from './account-fixture.js';

const realFetch = globalThis.fetch;
const input = { name: 'Private', url: 'https://vendor.example/mcp', header: 'Authorization', value: 'Bearer SOURCE_SECRET', clientId: '', clientSecret: '' };
const calls: string[] = [];

beforeEach(() => {
  configurePlatform({ kv: memoryKeyValue() });
  installTestAccount();
  calls.length = 0;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  clearAccount();
  configurePlatform({ kv: memoryKeyValue() });
});

const operations = [
  () => addOrgConnector(input),
  () => replaceOrgConnectorKey('conn0000001', 'Authorization', 'Bearer SOURCE_SECRET'),
  () => fetchOrgConnectors(),
];

for (const operation of operations) {
  for (const status of [200, 401]) {
    test(`${operation.toString()} refuses a different account after HTTP ${String(status)}, without a refresh or retry`, async () => {
      let release: (res: Response) => void = () => undefined;
      let began: () => void = () => undefined;
      const requested = new Promise<void>((resolve) => { began = resolve; });
      const pending = new Promise<Response>((resolve) => { release = resolve; });
      globalThis.fetch = ((url: string) => {
        calls.push(String(url));
        began();
        return pending;
      }) as typeof fetch;
      const running = operation();
      await requested;
      const current = installTestAccount({ org_id: 'org_OTHER0000000000' });
      storeAccount({ ...current, accessToken: testToken({ org_id: current.organization }) });
      release(Response.json({ connectors: [], admin: true }, { status }));
      await expect(running).rejects.toThrow('account changed');
      expect(calls).toHaveLength(1);
      expect(calls[0]).not.toContain('/refresh');
    });
  }
}

test('switching away and back during a request is not a new authorization for its body', async () => {
  const first = installTestAccount();
  globalThis.fetch = (() => {
    installTestAccount({ org_id: 'org_OTHER0000000000' });
    storeAccount(first);
    return Promise.resolve(Response.json({}, { status: 401 }));
  }) as typeof fetch;
  await expect(addOrgConnector(input)).rejects.toThrow('account changed');
});
