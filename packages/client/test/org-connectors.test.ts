import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { clearAccount } from '../src/auth/account.js';
import { configurePlatform, location, memoryKeyValue, type Location } from '../src/platform.js';
import {
  addOrgConnector,
  signInOrgConnector,
  assignOrgConnector,
  fetchOrgConnectorTools,
  setOrgConnectorPolicy,
  setOrgConnectorAgentPolicy,
  fetchOrgConnectors,
  takeOrgConnectorReturn,
  toOrgConnector,
  unassignOrgConnector,
} from '../src/api/org-connectors.js';
import { installTestAccount } from './account-fixture.js';

const BASE = 'https://api.metro.box/api/connectors';
const realFetch = globalThis.fetch;
const realLocation = location();

interface Seen {
  url: string;
  method: string | undefined;
  body: unknown;
}

let calls: Seen[] = [];

function serve(body: unknown, status = 200): void {
  calls = [];
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
    return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
  }) as unknown as typeof fetch;
}

const ROW = { id: 'aB3-_xYz9Qw', name: 'Linear', url: 'https://mcp.linear.app/mcp', auth: 'oauth', header: null, signIn: 'disconnected', readOnly: true, agents: [{ id: 'zz9-_xYz9Qw', readOnly: true, assignedAt: '2026-10-11T05:00:00.000Z' }] };

const NEW = { name: ' Linear ', url: 'https://mcp.linear.app/mcp', header: '', value: '', clientId: '', clientSecret: '' };

beforeAll(() => {
  configurePlatform({ kv: memoryKeyValue() });
  installTestAccount();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  configurePlatform({ location: realLocation });
});

afterAll(() => {
  clearAccount();
});

describe('the organization connectors client', () => {
  test('reads a connector with safe defaults and never invents a secret', () => {
    expect(toOrgConnector(ROW)).toMatchObject({ id: 'aB3-_xYz9Qw', auth: 'oauth', signIn: 'disconnected', readOnly: true, server: null, agents: [{ id: 'zz9-_xYz9Qw', readOnly: true }] });
    expect(toOrgConnector({ id: 'x', name: 'y', auth: 'weird', signIn: 'maybe' })).toMatchObject({ auth: 'none', signIn: null, readOnly: false, agents: [] });
    expect(() => toOrgConnector({ name: 'no id' })).toThrow('unexpected response');
  });

  test('lists, adds with a return address, and refuses a sign-in address that is not a web page', async () => {
    serve({ connectors: [ROW], admin: true });
    expect((await fetchOrgConnectors()).admin).toBe(true);
    expect(calls[0]).toEqual({ url: BASE, method: 'GET', body: undefined });
    serve({ connector: ROW, authorizeUrl: 'https://mcp.linear.app/authorize?state=x' }, 201);
    expect(await addOrgConnector(NEW)).toMatchObject({ kind: 'oauth', authorizeUrl: 'https://mcp.linear.app/authorize?state=x' });
    expect(calls[0]?.body).toEqual({ name: 'Linear', url: 'https://mcp.linear.app/mcp', returnTo: '' });
    serve({ connector: ROW, authorizeUrl: 'javascript:alert(1)' }, 201);
    await expect(addOrgConnector(NEW)).rejects.toThrow('will not open');
    serve({ connector: { ...ROW, auth: 'header' } }, 201);
    expect((await addOrgConnector({ ...NEW, value: 'Bearer k' })).kind).toBe('added');
  });

  test('assignments are a PUT and a DELETE on the agent under the connector', async () => {
    serve(ROW);
    await assignOrgConnector('aB3-_xYz9Qw', 'zz9-_xYz9Qw', true);
    expect(calls[0]).toEqual({ url: `${BASE}/aB3-_xYz9Qw/agents/zz9-_xYz9Qw`, method: 'PUT', body: { readOnly: true } });
    serve(ROW);
    await unassignOrgConnector('aB3-_xYz9Qw', 'zz9-_xYz9Qw');
    expect(calls[0]).toEqual({ url: `${BASE}/aB3-_xYz9Qw/agents/zz9-_xYz9Qw`, method: 'DELETE', body: undefined });
  });

  test('tool discovery is a scoped GET and preserves vendor names and read-only hints', async () => {
    serve({ tools: [{ name: 'delete_file', title: 'Delete file', description: 'Deletes a file', readOnly: false }, { name: 'fetch', readOnly: true }] });
    expect(await fetchOrgConnectorTools(ROW.id)).toEqual([{ name: 'delete_file', title: 'Delete file', description: 'Deletes a file', readOnly: false }, { name: 'fetch', title: 'fetch', description: '', readOnly: true }]);
    expect(calls).toEqual([{ url: `${BASE}/${ROW.id}/tools`, method: 'GET', body: undefined }]);
  });

  test('full organization and assignment policies are retained and written independently by instance ID', async () => {
    const policy = { read: 'ask', write: 'deny', tools: { special: 'allow', old_tool: 'deny' } } as const;
    const agentPolicy = { tools: { special: 'deny' } } as const;
    const row = { ...ROW, policy, agents: [{ ...ROW.agents[0], policy: agentPolicy }] };
    expect(toOrgConnector(row).policy).toEqual(policy);
    expect(toOrgConnector(row).agents[0]?.policy).toEqual(agentPolicy);
    expect(toOrgConnector(ROW).policy).toEqual({ write: 'deny' });
    serve(row);
    await setOrgConnectorPolicy('instance001', policy);
    await setOrgConnectorAgentPolicy('instance002', 'zz9-_xYz9Qw', agentPolicy);
    await assignOrgConnector('instance002', 'zz9-_xYz9Qw');
    expect(calls).toEqual([
      { url: `${BASE}/instance001`, method: 'PUT', body: { policy } },
      { url: `${BASE}/instance002/agents/zz9-_xYz9Qw/policy`, method: 'PUT', body: { policy: agentPolicy } },
      { url: `${BASE}/instance002/agents/zz9-_xYz9Qw`, method: 'PUT', body: {} },
    ]);
  });

  test('a new agent policy write fails closed against an older API without falling back to assignment', async () => {
    const path = `${BASE}/${ROW.id}/agents/zz9-_xYz9Qw`;
    let readOnly = true;
    calls = [];
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as { readOnly?: boolean };
      calls.push({ url, method: init?.method, body });
      if (url === path) {
        readOnly = body.readOnly === true;
        return Promise.resolve(Response.json({ ...ROW, agents: [{ ...ROW.agents[0], readOnly }] }));
      }
      return Promise.resolve(Response.json({ error: 'not found' }, { status: 404 }));
    }) as unknown as typeof fetch;
    await expect(setOrgConnectorAgentPolicy(ROW.id, 'zz9-_xYz9Qw', { write: 'deny' })).rejects.toThrow('not found');
    expect(calls).toEqual([{ url: `${path}/policy`, method: 'PUT', body: { policy: { write: 'deny' } } }]);
    expect(readOnly).toBe(true);
  });

  test('the sign-in return is read once from the address and cleared', () => {
    let search = '?org_connector=handoff-1&keep=1';
    const cleared: string[] = [];
    const fake: Location = { ...realLocation, search: () => search, clearSearch: (query) => {
      cleared.push(query);
      search = query === '' ? '' : `?${query}`;
    } };
    configurePlatform({ location: fake });
    expect(takeOrgConnectorReturn()).toEqual({ kind: 'handoff', handoff: 'handoff-1' });
    expect(cleared).toEqual(['keep=1']);
    expect(takeOrgConnectorReturn()).toBeNull();
    search = '?org_connector_error=The+sign-in+was+declined.';
    expect(takeOrgConnectorReturn()).toEqual({ kind: 'error', error: 'The sign-in was declined.' });
  });
});


test('organization add and legacy sign-in forward only an explicitly typed resource, never the saved URL', async () => {
  const resource = 'https://mcp.linear.app/public/workspace';
  serve({ connector: ROW, authorizeUrl: 'https://mcp.linear.app/authorize' }, 201);
  await addOrgConnector({ ...NEW, oauthResource: ` ${resource} ` });
  expect(calls[0]?.body).toEqual({ name: 'Linear', url: NEW.url, returnTo: '', oauthResource: resource });
  await addOrgConnector({ ...NEW, oauthResource: '  ' });
  expect(calls[1]?.body).not.toHaveProperty('oauthResource');
  serve({ authorizeUrl: 'https://mcp.linear.app/authorize' });
  let checked = 0;
  const signal = new AbortController().signal;
  await signInOrgConnector(ROW.id, () => { checked += 1; }, signal, ` ${resource} `);
  expect(checked).toBeGreaterThan(0);
  expect(calls[0]).toEqual({ url: `${BASE}/${ROW.id}/sign-in`, method: 'POST', body: { returnTo: '', oauthResource: resource } });
  await signInOrgConnector(ROW.id);
  expect(calls[1]?.body).toEqual({ returnTo: '' });
  await signInOrgConnector(ROW.id, undefined, undefined, '  ');
  expect(calls[2]?.body).toEqual({ returnTo: '' });
});
