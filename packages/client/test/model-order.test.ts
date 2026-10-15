import { describe, expect, test } from 'bun:test';
import { toModelSettings } from '../src/api/model.js';
import { modelAccount, modelOrder, routeItems } from '../src/api/model-order.js';

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
    expect(rows.map((r) => modelAccount(r))).toEqual(['alice@example.invalid', 'bob@example.invalid']);
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

  test('a removed connection shows as unavailable and exposes no usage', () => {
    const value = settings();
    value.connections = value.connections.filter((c) => c.id !== 'a');
    value.usage.passthrough = reading(0.9);
    const row = modelOrder(value)[0];
    expect(row?.usage).toBeUndefined();
    if (row === undefined) throw new Error('missing primary row');
    expect(modelAccount(row)).toBe('Connection unavailable');
  });

  test('no route means no model order at all', () => {
    expect(modelOrder(toModelSettings({ route: '', source: null, connections: [], usage: { 'local:session': reading(0.3) } }))).toEqual([]);
  });

  test('a Claude subscription and an Anthropic key say what they hold, since neither reports an account', () => {
    const value = toModelSettings({ route: 's', model: 'claude-sonnet-5-5', fallbacks: [{ connection: 'k', model: 'claude-x' }], connections: [{ id: 's', provider: 'anthropic', label: 'Max', subscription: true }, { id: 'k', provider: 'anthropic', label: 'Key' }] });
    expect(modelOrder(value).map((row) => modelAccount(row))).toEqual(['Claude subscription', 'API key']);
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
