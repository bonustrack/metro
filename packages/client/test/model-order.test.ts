import { describe, expect, test } from 'bun:test';
import { toModelSettings } from '../src/api/model.js';
import { effectiveRoute, modelAccount, modelOrder, routeItems } from '../src/api/model-order.js';
import { LOCAL_SESSION } from '../src/api/model-route.js';

const connection = (id: string, email: string | null) => ({ id, provider: 'codex', label: `Connection ${id}`, model: 'gpt-6-astra', account: { email, plan: null, method: 'chatgpt' } });
const reading = (used: number) => ({ at: '2026-10-06T10:00:00Z', windows: [{ label: 'Weekly', used, resetAt: null }] });
const settings = () => toModelSettings({
  route: 'a', model: 'gpt-6-astra', fallbacks: [{ connection: 'b', model: 'gpt-6-astra' }],
  source: 'organization',
  connections: [connection('a', 'alice@example.invalid'), connection('b', 'bob@example.invalid')],
  chain: [{ connection: 'a', model: 'gpt-6-astra', active: true }, { connection: 'b', model: 'gpt-6-astra', active: false }],
  usage: { a: reading(0.47), b: reading(0) },
});

describe('ranked model accounts and usage', () => {
  test('same-model connections keep their exact account and reading in rank order', () => {
    const rows = modelOrder(settings());
    expect(rows.map((r) => r.connection?.id)).toEqual(['a', 'b']);
    expect(rows.map((r) => r.slot)).toEqual([{ kind: 'primary' }, { kind: 'fallback', at: 0 }]);
    expect(rows.map((r) => modelAccount(r, 'unrelated@example.invalid'))).toEqual(['alice@example.invalid', 'bob@example.invalid']);
    expect(rows.map((r) => r.usage?.windows[0]?.used)).toEqual([0.47, 0]);
    expect(rows.map((r) => r.row?.active)).toEqual([true, false]);
  });

  test('a fallback matching the primary cannot borrow its active chain entry', () => {
    const value = settings();
    value.route = { primary: { connection: 'a', model: 'gpt-6-astra' }, fallbacks: [{ connection: 'a', model: 'gpt-6-astra' }] };
    const rows = modelOrder(value);
    expect(rows[0]?.row?.active).toBe(true);
    expect(rows[1]?.row).toBeUndefined();
    expect(rows[1]?.usage).toBe(value.usage.a);
  });

  test('a removed connection shows as unavailable and exposes no usage or server login', () => {
    const value = settings();
    value.connections = value.connections.filter((c) => c.id !== 'a');
    value.usage.passthrough = reading(0.9);
    const row = modelOrder(value)[0];
    expect(row?.usage).toBeUndefined();
    if (row === undefined) throw new Error('missing primary row');
    expect(modelAccount(row, 'server@example.invalid')).toBe('Connection unavailable');
  });

  test('no route means the session login of the server, with its reading and account', () => {
    const value = toModelSettings({ route: '', source: null, connections: [], usage: { 'local:session': reading(0.3) } });
    expect(effectiveRoute(value).primary.connection).toBe(LOCAL_SESSION);
    const row = modelOrder(value)[0];
    expect(row?.usage?.windows[0]?.used).toBe(0.3);
    expect(row?.row?.active).toBe(true);
    if (row === undefined) throw new Error('missing primary row');
    expect(modelAccount(row, 'server@example.invalid')).toBe('server@example.invalid');
    expect(modelAccount(row, null)).toBe('Account not reported');
  });

  test('a Claude login of the box names its own account, never the session login', () => {
    const value = toModelSettings({ route: 'local:login0000001', model: 'claude-sonnet-5-5', fallbacks: [], connections: [], claude: [{ id: 'login0000001', email: 'own@example.invalid' }] });
    const row = modelOrder(value)[0];
    if (row === undefined) throw new Error('missing primary row');
    expect(modelAccount(row, 'server@example.invalid')).toBe('own@example.invalid');
    const keyed = toModelSettings({ route: 'k', model: 'claude-x', fallbacks: [], connections: [{ id: 'k', provider: 'anthropic', label: 'Key' }] });
    const first = modelOrder(keyed)[0];
    if (first === undefined) throw new Error('missing primary row');
    expect(modelAccount(first, 'server@example.invalid')).toBe('API key');
  });

  test('a fallback uses its chosen model and exact chain entry, not the connection default', () => {
    const value = settings();
    value.route = { primary: { connection: 'a', model: 'gpt-6-astra' }, fallbacks: [{ connection: 'a', model: 'gpt-other' }] };
    value.chain.push({ connection: 'a', model: 'gpt-other', used: 0.2, hold: null, active: false });
    expect(modelOrder(value)[1]).toMatchObject({ model: 'gpt-other', row: { model: 'gpt-other', used: 0.2 }, usage: value.usage.a });
  });

  test('an organization route lists its steps with no usage', () => {
    const value = settings();
    const route = { primary: { connection: 'b', model: 'm1' }, fallbacks: [{ connection: 'gone', model: 'm2' }] };
    const items = routeItems(route, value.connections);
    expect(items.map((i) => [i.slot.kind, i.connection?.id, i.model, i.usage, i.row])).toEqual([['primary', 'b', 'm1', undefined, undefined], ['fallback', undefined, 'm2', undefined, undefined]]);
  });
});
