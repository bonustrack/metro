import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import { randomInt } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { copyOrganizations } from '../src/connectors/copy.ts';
import type { WorkosConfig } from '../src/auth/workos.ts';
import { TEST_OWNER, TEST_STRANGER } from './identity-helper.ts';

let server: Server;
let config: WorkosConfig;
let status: number;
let requests: URL[];

beforeAll(async () => {
  server = createServer((req, res) => {
    requests.push(new URL(req.url ?? '/', 'http://fixture.invalid'));
    const data = [
      { organization_id: TEST_OWNER, role: { slug: 'admin' }, status: 'active' },
      { organization_id: TEST_STRANGER, role: { slug: 'admin' }, status: 'active' },
      { organization_id: 'org_01INACTIVE000000', role: { slug: 'admin' }, status: 'inactive' },
      { organization_id: 'org_01UNKNOWN0000000', role: { slug: 'admin' } },
    ];
    const payload = status === 200 ? { data } : { code: 'service_unavailable', message: 'Provider-private-error-fixture' };
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(payload));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(randomInt(10_000, 30_000), '127.0.0.1', resolve);
  });
  config = { base: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`, apiKey: 'stand-in-workos-key', clientId: 'fixture-client' };
});

beforeEach(() => {
  status = 200;
  requests = [];
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => { server.close((err) => { if (err === undefined) resolve(); else reject(err); }); });
});

describe('the production copy membership adapter', () => {
  test('one fresh active-membership request checks the verified user without looking up organization names', async () => {
    const user = 'user_fixture+special/@';
    expect(await copyOrganizations(config, user)).toEqual([{ id: TEST_OWNER, role: 'admin' }, { id: TEST_STRANGER, role: 'admin' }]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.pathname).toBe('/user_management/organization_memberships');
    expect(requests[0]?.searchParams.get('user_id')).toBe(user);
    expect(requests[0]?.searchParams.get('statuses')).toBe('active');
    await copyOrganizations(config, user);
    expect(requests).toHaveLength(2);
  });

  test('an actual WorkOS refusal becomes a sanitized temporary-unavailability response', async () => {
    status = 503;
    await expect(copyOrganizations(config, 'user_fixture')).rejects.toMatchObject({ status: 503, message: 'Metro could not verify organization admin memberships. Try again.' });
    expect(requests).toHaveLength(1);
  });

  test('a transport failure also fails closed without exposing its error or configuration', async () => {
    await expect(copyOrganizations({ ...config, base: 'http://127.0.0.1:1' }, 'user_fixture')).rejects.toMatchObject({ status: 503, message: 'Metro could not verify organization admin memberships. Try again.' });
    expect(requests).toEqual([]);
  });

  test('missing sign-in configuration is unavailable without a network request', async () => {
    await expect(copyOrganizations(null, 'user_fixture')).rejects.toMatchObject({ status: 503, message: 'sign-in is not configured on this server' });
    expect(requests).toEqual([]);
  });
});
