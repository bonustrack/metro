import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { clearAccount } from '../src/auth/account.js';
import { setCurrentServer } from '../src/auth/daemon.js';
import { configurePlatform, memoryKeyValue } from '../src/platform.js';
import { fetchMigrationPreview, MIGRATION_UPDATE } from '../src/api/connector-migration.js';
import { installTestAccount, TEST_ORGANIZATION } from './account-fixture.js';

const realFetch = globalThis.fetch;
const LOCAL = 'https://source.example/api/connectors/migration-preview';
const CENTRAL = 'https://api.metro.box/api/connectors';
const AGENT = 'source00001';
const source = () => ({ id: 'conn0000001', name: 'Calendar', auth: 'oauth', origin: 'https://calendar.example', policy: { read: 'ask', write: 'deny', tools: { special: 'allow' } }, policySupported: false, issues: ['oauth_sign_in', 'custom_policy'] });
const preview = () => ({ enabled: true, enrolled: true, agentId: AGENT, owner: TEST_ORGANIZATION, liveEnabled: false, connectors: [source()] });
let local: unknown;
let organization: unknown;
let localStatus: number;
let organizationStatus: number;
let requests: Array<{ url: string; init: RequestInit }>;

beforeEach(() => {
  configurePlatform({ kv: memoryKeyValue(), tabKv: memoryKeyValue() });
  installTestAccount();
  setCurrentServer({ id: AGENT, host: 'source.example' });
  local = preview();
  organization = { admin: true, connectors: [] };
  localStatus = 200;
  organizationStatus = 200;
  requests = [];
  globalThis.fetch = ((input: string, init: RequestInit = {}) => {
    requests.push({ url: input, init });
    if (input === LOCAL) return Promise.resolve(Response.json(local, { status: localStatus }));
    if (input === CENTRAL) return Promise.resolve(Response.json(organization, { status: organizationStatus }));
    throw new Error('Unexpected request');
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  setCurrentServer(null);
  clearAccount();
});

describe('organization migration preparation', () => {
  test('reads metadata only, keeps exact custom policies and does not send a mutation', async () => {
    const result = await fetchMigrationPreview();
    expect(result.organizationChecked).toBe(true);
    expect(result.rows[0]?.source.policy).toEqual(source().policy);
    expect(result.rows[0]?.source.issues).toEqual(['oauth_sign_in', 'custom_policy']);
    expect(result.rows[0]?.conflicts).toEqual([]);
    expect(requests.map((row) => [row.url, row.init.method, row.init.body])).toEqual([[LOCAL, 'GET', undefined], [CENTRAL, 'GET', undefined]]);
    expect(requests[0]?.init.redirect).toBe('error');
    expect(requests[0]?.init.signal).toBeInstanceOf(AbortSignal);
  });

  test('the disabled capability never reads organization connectors', async () => {
    local = { enabled: false, enrolled: false, agentId: null, owner: null, liveEnabled: false, connectors: [] };
    expect(await fetchMigrationPreview()).toMatchObject({ preview: { enabled: false }, rows: [], organizationChecked: false });
    expect(requests.map((row) => row.url)).toEqual([LOCAL]);
  });

  test('old daemons give an explicit update notice, not an empty successful preview', async () => {
    localStatus = 404;
    local = { error: 'fixture-private-error' };
    await expect(fetchMigrationPreview()).rejects.toThrow(MIGRATION_UPDATE);
    expect(requests).toHaveLength(1);
  });

  test('name and service conflicts remain separate, with existing source assignments shown', async () => {
    organization = { admin: true, connectors: [
      { id: 'same-name', name: ' calendar ', url: 'https://other.example/mcp', agents: [{ id: AGENT }] },
      { id: 'same-service', name: 'Other calendar account', url: 'https://calendar.example/private-key-in-path?key=fixture-secret', agents: [] },
      { id: 'unrelated', name: 'Tasks', url: 'https://tasks.example', agents: [{ id: AGENT }] },
    ] };
    const result = await fetchMigrationPreview();
    expect(result.rows[0]?.conflicts).toEqual([
      { id: 'same-name', name: ' calendar ', kind: 'name', assigned: true },
      { id: 'same-service', name: 'Other calendar account', kind: 'service', assigned: false },
    ]);
    expect(JSON.stringify(result)).not.toContain('fixture-secret');
    expect(JSON.stringify(result)).not.toContain('private-key-in-path');
  });

  test('unexpected source fields never enter the projected preview', async () => {
    local = { ...preview(), secret: 'fixture-top-secret', connectors: [{ ...source(), url: 'https://calendar.example/fixture-secret', config: { token: 'fixture-token' }, clientSecret: 'fixture-client-secret' }] };
    const text = JSON.stringify(await fetchMigrationPreview());
    for (const secret of ['fixture-top-secret', 'fixture-secret', 'fixture-token', 'fixture-client-secret']) expect(text).not.toContain(secret);
  });

  test('raw URLs and malformed policy rules fail closed instead of being simplified', async () => {
    for (const changes of [
      { origin: 'https://calendar.example/path?token=fixture-secret' },
      { origin: 'https://name:fixture-secret@calendar.example' },
      { policy: { write: 'sometimes' } },
      { policy: { tools: { x: 123 } } },
      { policy: { write: 'deny', other: 'fixture-secret' } },
      { issues: ['fixture-secret'] },
      { auth: 'unknown' },
    ]) {
      local = { ...preview(), connectors: [{ ...source(), ...changes }] };
      await expect(fetchMigrationPreview()).rejects.toThrow('invalid migration preview');
    }
    expect(requests.every((row) => row.url === LOCAL)).toBe(true);
  });

  test('prototype-named tool rules are preserved as own properties', async () => {
    const tools = Object.fromEntries([['__proto__', 'deny'], ['constructor', 'ask'], ['toString', 'allow']]);
    local = { ...preview(), connectors: [{ ...source(), policy: { tools } }] };
    const policy = (await fetchMigrationPreview()).rows[0]?.source.policy;
    expect(Object.entries(policy?.tools ?? {})).toEqual(Object.entries(tools));
    expect(Object.hasOwn(policy?.tools ?? {}, '__proto__')).toBe(true);
  });

  test('members cannot fetch the preview even when it is off', async () => {
    installTestAccount({ role: 'member' });
    await expect(fetchMigrationPreview()).rejects.toThrow('Only an organization admin');
    expect(requests).toHaveLength(0);
  });

  test('a wrong owner or enrolled agent is rejected before loading target metadata', async () => {
    local = { ...preview(), owner: 'org_other' };
    await expect(fetchMigrationPreview()).rejects.toThrow('does not match');
    local = { ...preview(), agentId: 'other000001' };
    await expect(fetchMigrationPreview()).rejects.toThrow('does not match');
    expect(requests.every((row) => row.url === LOCAL)).toBe(true);
  });

  test('an organization metadata failure never becomes a no-conflicts result', async () => {
    organizationStatus = 503;
    organization = { error: 'Organization connectors are not switched on yet.' };
    await expect(fetchMigrationPreview()).rejects.toThrow('not switched on');
    organizationStatus = 200;
    organization = { admin: false, connectors: [] };
    await expect(fetchMigrationPreview()).rejects.toThrow('Only an organization admin');
  });

  test('switching agents or accounts while a read is in flight discards it', async () => {
    const serve = globalThis.fetch;
    globalThis.fetch = ((input: string, init?: RequestInit) => {
      const response = serve(input, init);
      setCurrentServer({ id: 'other000001', host: 'other.example' });
      return response;
    }) as unknown as typeof fetch;
    await expect(fetchMigrationPreview()).rejects.toThrow('account, agent or enrollment changed');
    expect(requests).toHaveLength(1);
    setCurrentServer({ id: AGENT, host: 'source.example' });
    globalThis.fetch = ((input: string, init?: RequestInit) => {
      const response = serve(input, init);
      installTestAccount({ org_id: 'org_other' });
      return response;
    }) as unknown as typeof fetch;
    await expect(fetchMigrationPreview()).rejects.toThrow('changed');
    expect(requests.every((row) => row.url === LOCAL)).toBe(true);
  });
});
