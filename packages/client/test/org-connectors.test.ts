import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { clearAccount } from '../src/auth/account.js';
import { configurePlatform, location, memoryKeyValue, type Location } from '../src/platform.js';
import {
  addOrgConnector,
  assignOrgConnector,
  fetchOrgConnectorEvents,
  fetchOrgConnectors,
  orgEventText,
  takeOrgConnectorReturn,
  toOrgConnector,
  toOrgEvents,
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

  test('the audit log pages with the cursor the api gave and reads as sentences', async () => {
    serve({ events: [], next: null });
    await fetchOrgConnectorEvents('aB3-_xYz9Qw', { before: '2026-10-11T05:00:00.000Z', beforeId: 'ev0-_xYz9Qw' });
    expect(calls[0]?.url).toBe(`${BASE}/events?connector=aB3-_xYz9Qw&before=2026-10-11T05%3A00%3A00.000Z&beforeId=ev0-_xYz9Qw`);
    const page = toOrgEvents({
      events: [
        { id: '1', at: 't', action: 'connector.assigned', actor: { kind: 'user', id: 'u', name: 'Less' }, connector: { id: 'c', name: 'Linear' }, agent: { id: 'a', name: null }, detail: { name: 'Linear', readOnly: 'yes' } },
        { id: '2', at: 't', action: 'connector.deleted', actor: { kind: 'user', id: 'u', name: null, email: 'less@example.com' }, connector: { id: 'c', name: null }, agent: null, detail: { name: 'Old' } },
        { id: '3', at: 't', action: 'agent.unenrolled', actor: { kind: 'metro' }, connector: null, agent: { id: 'a', name: 'Andy' }, detail: {} },
      ],
      next: { before: 't', beforeId: '3' },
    });
    const names = (id: string): string | null => (id === 'a' ? 'Tony' : null);
    expect(page.events.map((e) => orgEventText(e, names))).toEqual([
      'Less gave Linear to Tony, read-only',
      'less@example.com removed Old',
      'Tony moved to another organization, so its agent key and connectors were removed',
    ]);
    expect(page.next).toEqual({ before: 't', beforeId: '3' });
  });

  test('old and new enrollment events use agent wording without rewriting stored history', () => {
    const actions = ['agent.enrolled', 'box.enrolled', 'agent.unenrolled', 'box.unenrolled'];
    const page = toOrgEvents({ events: actions.map((action) => ({ id: action, at: 't', action, actor: { kind: 'user', id: 'u', name: 'Less' }, connector: null, agent: { id: 'a', name: 'Tony' }, detail: {} })), next: null });
    expect(page.events.map((event) => event.action)).toEqual(actions);
    expect(page.events.map((event) => orgEventText(event, () => null))).toEqual([
      'Less enrolled Tony',
      'Less enrolled Tony',
      'Tony moved to another organization, so its agent key and connectors were removed',
      'Tony moved to another organization, so its agent key and connectors were removed',
    ]);
  });

  test('central refresh activity uses agent names and retains a removed connector name', () => {
    const actions = ['connector.refreshed', 'connector.refresh_failed', 'connector.signed_out', 'connector.delivered'];
    const page = toOrgEvents({ events: actions.map((action) => ({ id: action, at: 't', action, actor: { kind: 'agent', id: 'a' }, connector: null, agent: { id: 'a', name: 'Tony' }, detail: { name: 'Old connector' } })), next: null });
    expect(page.events.map((event) => orgEventText(event, () => null))).toEqual([
      'Metro refreshed Old connector for Tony',
      'Metro could not refresh Old connector for Tony',
      'Old connector needs signing in again',
      'Metro prepared Old connector for Tony',
    ]);
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
