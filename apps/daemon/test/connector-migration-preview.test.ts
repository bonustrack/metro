import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as dns from 'node:dns';
import * as https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiError } from '@metro-labs/http/api-error';
import { newAgentKey, saveAgentKey } from '../src/connectors/agent-key.ts';
import { connectorMigrationPreview } from '../src/connectors/migration-preview.ts';
import { onPoliciesChanged } from '../src/policy/policy.ts';

const OWNER = 'org_01MIGRATIONOWNER00';
const AGENT = 'apiagent001';
const ID = 'conn0000001';
const ENV = ['METRO_CONNECTORS_SYNC_ENABLED', 'METRO_CONNECTORS_LIVE_ENABLED'] as const;
let saved: Record<string, string | undefined> = {};
let dir = '';

const config = (extra: Record<string, unknown> = {}) => ({ auth: { kind: 'none' }, createdAt: '', verified: { at: '', server: '' }, oauth: false, client: null, ...extra });
const row = (extra: Record<string, unknown> = {}) => ({ id: ID, name: 'Example', url: 'https://mcp.example.com/private-path?key=query-secret', config: config(), ...extra });
const write = (connectors: unknown[]) => fs.writeFileSync(join(dir, 'connectors.json'), JSON.stringify({ version: 1, connectors }, null, 2));
const preview = () => connectorMigrationPreview(OWNER, dir);
const files = () => Object.fromEntries(fs.readdirSync(dir).map((name) => [name, { bytes: fs.readFileSync(join(dir, name), 'utf8'), mode: fs.statSync(join(dir, name)).mode, modified: fs.statSync(join(dir, name)).mtimeMs }]));

beforeEach(() => {
  saved = Object.fromEntries(ENV.map((key) => [key, process.env[key]]));
  process.env.METRO_CONNECTORS_SYNC_ENABLED = 'true';
  delete process.env.METRO_CONNECTORS_LIVE_ENABLED;
  dir = fs.mkdtempSync(join(tmpdir(), 'metro-migration-preview-'));
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('off by default and for every non-true switch value, with no connector or identity reads', () => {
  const reads = spyOn(fs, 'readFileSync').mockImplementation((path) => {
    expect(String(path)).toBe(join(dir, 'org-connector-sync.json'));
    throw Object.assign(new Error('absent setting'), { code: 'ENOENT' });
  });
  const exists = spyOn(fs, 'existsSync').mockImplementation(() => { throw new Error('must not inspect'); });
  try {
    for (const value of [undefined, '', 'false', '1', 'TRUE']) {
      if (value === undefined) delete process.env.METRO_CONNECTORS_SYNC_ENABLED; else process.env.METRO_CONNECTORS_SYNC_ENABLED = value;
      expect(preview()).toEqual({ migrationSupported: true, oauthResourceSupported: true, enabled: false, enrolled: false, agentId: null, owner: OWNER, liveEnabled: false, connectors: [] });
    }
    process.env.METRO_CONNECTORS_LIVE_ENABLED = 'true';
    expect(preview().liveEnabled).toBe(true);
    expect(reads).toHaveBeenCalledTimes(6);
    expect(exists).not.toHaveBeenCalled();
  } finally {
    reads.mockRestore(); exists.mockRestore();
  }
});

test('enrollment uses the current API agent id only for the matching organization, never the local agent id', () => {
  write([]);
  fs.writeFileSync(join(dir, 'agent.json'), JSON.stringify({ id: 'localagent1', key: 'local-agent-secret' }));
  expect(preview()).toMatchObject({ enabled: true, enrolled: false, agentId: null });
  saveAgentKey(newAgentKey(), { server: AGENT, organization: OWNER, at: '2026-10-11T00:00:00Z' }, dir);
  const before = files();
  expect(preview()).toEqual({ migrationSupported: true, oauthResourceSupported: true, enabled: true, enrolled: true, agentId: AGENT, owner: OWNER, liveEnabled: false, connectors: [] });
  expect(connectorMigrationPreview('org_01OTHEROWNER00000', dir)).toMatchObject({ enrolled: false, agentId: null });
  expect(connectorMigrationPreview(null, dir)).toMatchObject({ enrolled: false, agentId: null, owner: null });
  expect(files()).toEqual(before);
});

test('legacy enrollment is read without renaming it and malformed enrollment stays unenrolled', () => {
  saveAgentKey(newAgentKey(), { server: AGENT, organization: OWNER, at: '' }, dir);
  fs.renameSync(join(dir, 'agent-key.json'), join(dir, 'box-key.json'));
  const before = files();
  expect(preview().agentId).toBe(AGENT);
  expect(files()).toEqual(before);
  fs.writeFileSync(join(dir, 'agent-key.json'), '{bad identity-secret');
  const malformed = files();
  expect(preview()).toMatchObject({ enrolled: false, agentId: null });
  expect(files()).toEqual(malformed);
  expect(JSON.stringify(preview())).not.toContain('identity-secret');
});

test('only sanitized metadata and full policy leave the box; preview never transfers credentials', () => {
  const policy = { read: 'ask', write: 'deny', tools: { read_tool: 'allow', delete_tool: 'ask' } };
  const oauth = { kind: 'oauth', accessToken: 'access-secret', refreshToken: 'refresh-secret', clientId: 'client-id-secret', clientSecret: 'client-secret', tokenEndpoint: 'https://auth.example.com/private-token-path?key=token-endpoint-secret', issuer: 'https://auth.example.com/issuer-secret', scope: 'scope-secret', expiresAt: 1 };
  write([
    row({ config: config({ policy }) }),
    row({ id: 'conn0000002', name: 'Header', config: config({ auth: { kind: 'header', name: 'X-Secret-Header', value: 'header-secret' } }) }),
    row({ id: 'conn0000003', name: 'OAuth', config: config({ oauth: true, auth: oauth, client: { clientId: 'preset-id-secret', clientSecret: 'preset-secret' } }) }),
    row({ id: 'conn0000004', name: 'Signed out', config: config({ oauth: true }) }),
  ]);
  const before = files();
  const result = preview();
  expect(result.connectors[0]).toEqual({ id: ID, name: 'Example', auth: 'none', origin: 'https://mcp.example.com', policy, policySupported: true, issues: [] });
  expect(result.connectors[1]).toMatchObject({ auth: 'header', issues: [] });
  expect(result.connectors[2]).toMatchObject({ auth: 'oauth', issues: ['oauth_sign_in'] });
  expect(result.connectors[3]).toMatchObject({ auth: 'oauth', issues: ['oauth_sign_in'] });
  const text = JSON.stringify(result);
  for (const secret of ['private-path', 'query-secret', 'access-secret', 'refresh-secret', 'client-id-secret', 'client-secret', 'preset-id-secret', 'preset-secret', 'token-endpoint-secret', 'issuer-secret', 'scope-secret', 'header-secret', 'X-Secret-Header']) expect(text).not.toContain(secret);
  for (const key of ['url', 'config', 'clientId', 'clientSecret', 'accessToken', 'refreshToken', 'verified', 'keyId', 'signing', 'sealing', 'revision']) expect(text).not.toContain(`"${key}"`);
  expect(files()).toEqual(before);
});

test('malformed raw auth and configuration are retained and blocked instead of being normalized to no auth', () => {
  const configs: unknown[] = [
    undefined, null, [], 'config-secret', {},
    config({ auth: null }), config({ auth: [] }), config({ auth: { kind: 'other', value: 'bad-secret' } }),
    config({ auth: { kind: 'none', accessToken: 'bad-secret' } }),
    config({ auth: { kind: 'header', name: 'Authorization', value: 123 } }),
    config({ auth: { kind: 'header', name: '', value: 'bad-secret' } }),
    config({ auth: { kind: 'header', name: 'Authorization', value: 'bad\r\nsecret' } }),
    config({ auth: { kind: 'oauth', customAuth: 'unknown-secret' }, oauth: true }),
    config({ customConfig: 'unknown-secret' }),
    config({ client: { clientSecret: 'bad-secret' } }), config({ client: { clientId: 7 } }), config({ client: { clientId: 'id', clientSecret: 7 } }),
    config({ oauth: 'true' }), config({ createdAt: 7 }), config({ verified: [] }), config({ toolGroups: { x: 'maybe' } }),
  ];
  write(configs.map((value, index) => row({ id: `conn${String(index).padStart(7, '0')}`, name: `Example ${String(index)}`, config: value })));
  const before = files();
  const result = preview();
  expect(result.connectors).toHaveLength(configs.length);
  for (const connector of result.connectors) {
    expect(connector.auth).toBe('invalid');
    expect(connector.issues).toContain('invalid_config');
  }
  expect(JSON.stringify(result)).not.toContain('secret');
  expect(files()).toEqual(before);
});

test('malformed row identities have non-secret placeholders and duplicate rows are blocked', () => {
  write([null, 42, { id: 'https://private.example/path?token=secret', name: 'bad\nsecret' }, row(), row()]);
  const before = files();
  const result = preview();
  expect(result.connectors).toHaveLength(5);
  for (const connector of result.connectors.slice(0, 3)) expect(connector.issues).toContain('invalid_config');
  expect(result.connectors[2]).toMatchObject({ id: 'invalid-3', name: 'Connector 3' });
  expect(result.connectors[3]?.issues).toContain('invalid_config');
  expect(result.connectors[4]?.issues).toContain('invalid_config');
  expect(JSON.stringify(result)).not.toContain('secret');
  expect(files()).toEqual(before);
});

test('all representable policies retain exact read, write and tool overrides', () => {
  const cases = [
    { policy: undefined, supported: true, output: {} },
    { policy: {}, supported: true }, { policy: { read: 'allow', write: 'allow' }, supported: true },
    { policy: { write: 'deny' }, supported: true }, { policy: { read: 'allow', write: 'deny', tools: {} }, supported: true },
    { policy: { read: 'deny' }, supported: true }, { policy: { read: 'ask' }, supported: true },
    { policy: { write: 'ask' }, supported: true }, { policy: { tools: { read_tool: 'allow' } }, supported: true },
    { policy: { read: 'deny', write: 'ask', tools: { read_tool: 'ask', delete_tool: 'deny' } }, supported: true },
  ];
  for (const entry of cases) {
    write([row({ config: config({ policy: entry.policy }) })]);
    const connector = preview().connectors[0];
    expect(connector?.policy).toEqual(entry.output ?? entry.policy);
    expect(connector?.policySupported).toBe(entry.supported);
    expect(connector?.issues).toEqual(entry.supported ? [] : ['custom_policy']);
  }
});

test('valid prototype-shaped tool names retain every policy entry without prototype mutation', () => {
  const policy: unknown = JSON.parse('{"read":"allow","write":"deny","tools":{"__proto__":"ask","constructor":"allow","toString":"deny"}}');
  write([row({ config: config({ policy }) })]);
  const before = files();
  expect(preview().connectors[0]).toMatchObject({ policy, policySupported: false, issues: ['custom_policy'] });
  expect(Object.keys(preview().connectors[0]?.policy.tools ?? {})).toEqual(['__proto__', 'constructor', 'toString']);
  expect(files()).toEqual(before);
});

test('malformed policy never becomes a supported allow policy and never returns raw values', () => {
  for (const policy of [null, [], 'policy-secret', { write: 'policy-secret' }, { read: null }, { tools: null }, { tools: { read_tool: null } }, { tools: { 'url/path?secret': 'allow' } }, { ignored: 'policy-secret' }]) {
    write([row({ config: config({ policy }) })]);
    const before = files();
    const connector = preview().connectors[0];
    expect(connector).toMatchObject({ policy: {}, policySupported: false, issues: ['invalid_config'] });
    expect(JSON.stringify(connector)).not.toContain('secret');
    expect(files()).toEqual(before);
  }
});

test('static URL eligibility rejects http, local hostnames, private and special IP literals without probes', () => {
  for (const url of [
    'http://mcp.example.com/mcp', 'https://u:secret@mcp.example.com/path', 'https://mcp.example.com/path#secret', 'not-a-url-secret',
    'https://localhost/mcp', 'https://sub.localhost./mcp', 'https://machine.local/mcp', 'https://metadata.google.internal/mcp', 'https://singlehost/mcp',
    'https://127.0.0.1/mcp', 'https://2130706433/mcp', 'https://0x7f000001/mcp', 'https://10.0.0.1/mcp', 'https://172.16.0.1/mcp',
    'https://192.168.1.1/mcp', 'https://169.254.169.254/mcp', 'https://100.100.100.200/mcp', 'https://198.18.0.1/mcp', 'https://224.0.0.1/mcp',
    'https://[::1]/mcp', 'https://[::ffff:127.0.0.1]/mcp', 'https://[fc00::1]/mcp', 'https://[fe80::1]/mcp', 'https://[2001:db8::1]/mcp',
  ]) {
    write([row({ url })]);
    expect(preview().connectors[0]).toMatchObject({ origin: null, issues: ['unsupported_url'] });
  }
  for (const url of ['https://8.8.8.8/private?secret=1', 'https://[2606:4700:4700::1111]/private?secret=1', 'https://unresolved.example.com:8443/private?secret=1']) {
    write([row({ url })]);
    expect(preview().connectors[0]).toMatchObject({ origin: new URL(url).origin, issues: [] });
    expect(preview().connectors[0]).not.toHaveProperty('verified');
  }
});

test('missing file is empty; malformed top-level files fail safely without changing bytes', () => {
  expect(preview().connectors).toEqual([]);
  expect(fs.readdirSync(dir)).toEqual([]);
  for (const text of ['{raw-secret', 'null', '[]', '42', '{}', '{"version":2,"connectors":[]}', '{"version":1,"connectors":{"secret":"raw-secret"}}']) {
    fs.writeFileSync(join(dir, 'connectors.json'), text);
    const before = files();
    try {
      preview();
      throw new Error('should reject malformed source');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(503);
      expect((err as Error).message).toBe('Local connector configuration cannot be previewed. Restore its file or permissions first.');
      expect((err as Error).cause).toBeUndefined();
    }
    expect(files()).toEqual(before);
  }
});

test('preview makes no network, DNS, file mutations or policy publication even with expired OAuth and live mode on', () => {
  write([row({ config: config({ oauth: true, auth: { kind: 'oauth', accessToken: 'secret', clientId: 'id', tokenEndpoint: 'https://auth.example.com/token', issuer: 'https://auth.example.com', expiresAt: 1 } }) })]);
  saveAgentKey(newAgentKey(), { server: AGENT, organization: OWNER, at: '' }, dir);
  const before = files();
  let publications = 0;
  const stop = onPoliciesChanged(() => { publications += 1; });
  const fail = () => { throw new Error('preview must be read-only and offline'); };
  const spies = [spyOn(globalThis, 'fetch').mockImplementation(fail), spyOn(dns, 'lookup').mockImplementation(fail), spyOn(dns.promises, 'lookup').mockImplementation(fail), spyOn(https, 'request').mockImplementation(fail), spyOn(fs, 'writeFileSync').mockImplementation(fail), spyOn(fs, 'renameSync').mockImplementation(fail), spyOn(fs, 'rmSync').mockImplementation(fail), spyOn(fs, 'chmodSync').mockImplementation(fail)];
  try {
    process.env.METRO_CONNECTORS_LIVE_ENABLED = 'true';
    expect(preview()).toMatchObject({ enabled: true, enrolled: true, liveEnabled: true });
    expect(preview().connectors[0]?.issues).toEqual(['oauth_sign_in']);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(publications).toBe(0);
  } finally {
    for (const spy of spies) spy.mockRestore();
    stop();
  }
  expect(files()).toEqual(before);
});


test('discarded historical OAuth token metadata cannot block a fresh organization login', () => {
  const variants = [
    { kind: 'oauth' },
    { kind: 'oauth', accessToken: 'old-secret' },
    { kind: 'oauth', accessToken: '', refreshToken: '', clientId: '', tokenEndpoint: '', issuer: '', expiresAt: -1 },
    { kind: 'oauth', accessToken: 'old-secret', issuer: null, expiresAt: 'stale' },
    { kind: 'oauth', accessToken: 'old\r\nsecret', refreshToken: 7, clientId: 'id', tokenEndpoint: 'not-a-url' },
  ];
  for (const auth of variants) {
    write([row({ config: config({ auth }) })]);
    const before = files();
    expect(preview().connectors[0]).toMatchObject({ auth: 'oauth', issues: ['oauth_sign_in'] });
    expect(JSON.stringify(preview())).not.toContain('secret');
    expect(files()).toEqual(before);
  }
});

test('arbitrary public HTTPS OAuth paths and queries remain private, eligible migration sources', () => {
  for (const url of ['https://mcp.example.com/workspaces/demo/mcp', 'https://mcp.example.com/private-token?key=query-secret', 'https://mcp.example.com/sse', 'https://mcp.example.com/mcp/']) {
    write([row({ url, config: config({ oauth: true }) })]);
    expect(preview().connectors[0]).toMatchObject({ origin: 'https://mcp.example.com', auth: 'oauth', issues: ['oauth_sign_in'] });
    expect(JSON.stringify(preview())).not.toContain(url);
  }
});
