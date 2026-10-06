import { describe, expect, test } from 'bun:test';
import { toModelSettings } from '../src/api/model.js';
import { modelAccount, modelOrder } from '../src/api/model-order.js';

const connection = (id: string, account: string | null) => ({ id, account, provider: 'codex', label: `Connection ${id}`, model: 'gpt-6-astra', signedIn: true });
const reading = (used: number) => ({ at: '2026-10-06T10:00:00Z', windows: [{ label: 'Weekly', used, resetAt: null }] });
const settings = () => toModelSettings({
  route: 'a',
  connections: [connection('a', 'alice@example.invalid'), connection('b', 'bob@example.invalid')],
  fallbacks: [{ connection: 'b', model: 'gpt-6-astra' }],
  chain: [{ connection: 'a', model: 'gpt-6-astra', active: true }, { connection: 'b', model: 'gpt-6-astra', active: false }],
  usage: { a: reading(0.47), b: reading(0) },
});

describe('ranked model accounts and usage', () => {
  test('same-model connections keep their exact account and reading in rank order', () => {
    const rows = modelOrder(settings());
    expect(rows.map((r) => r.connection?.id)).toEqual(['a', 'b']);
    expect(rows.map((r) => r.model)).toEqual(['gpt-6-astra', 'gpt-6-astra']);
    expect(rows.map((r) => modelAccount(r, 'unrelated@example.invalid'))).toEqual(['alice@example.invalid', 'bob@example.invalid']);
    expect(rows.map((r) => r.usage?.windows[0]?.used)).toEqual([0.47, 0]);
    expect(rows.map((r) => r.row?.active)).toEqual([true, false]);
  });

  test('a fallback matching the primary cannot borrow its active chain entry', () => {
    const value = settings();
    value.fallbacks = [{ connection: 'a', model: 'gpt-6-astra' }];
    const rows = modelOrder(value);
    expect(rows[0]?.row?.active).toBe(true);
    expect(rows[1]?.row).toBeUndefined();
    expect(rows[1]?.usage).toBe(value.usage.a);
  });

  test('missing identities do not borrow the server account or another connection', () => {
    const value = settings();
    value.connections = value.connections.map((c) => ({ ...c, account: null }));
    for (const row of modelOrder(value)) expect(modelAccount(row, 'server@example.invalid')).toBe('Account not reported');
  });

  test('removed connections cannot expose leftover usage or the server login', () => {
    const value = settings();
    value.connections = [];
    const previous = value.usage.a;
    if (previous !== undefined) value.usage.passthrough = previous;
    for (const row of modelOrder(value)) {
      expect(row.usage).toBeUndefined();
      expect(row.passthrough).toBe(false);
      expect(modelAccount(row, 'server@example.invalid')).toBe('Connection unavailable');
    }
  });

  test('a new account with no usage never inherits the previous snapshot', () => {
    const before = modelOrder(settings())[0];
    const after = modelOrder(toModelSettings({ route: 'a', connections: [connection('a', 'new@example.invalid')], usage: {} }))[0];
    expect(before?.usage?.windows[0]?.used).toBe(0.47);
    expect(after?.connection?.account).toBe('new@example.invalid');
    expect(after?.usage).toBeUndefined();
  });

  test('only the passthrough or a legacy Claude login may use the server identity', () => {
    const value = toModelSettings({ route: '', connections: [], usage: { passthrough: reading(0.3) } });
    const row = modelOrder(value)[0];
    expect(row?.usage?.windows[0]?.used).toBe(0.3);
    expect(row?.row?.active).toBe(true);
    if (row === undefined) throw new Error('missing primary row');
    expect(modelAccount(row, 'server@example.invalid')).toBe('server@example.invalid');
    const legacy = { ...row, passthrough: false, connection: toModelSettings({ connections: [{ id: 'legacy', provider: 'anthropic' }] }).connections[0] };
    expect(modelAccount(legacy, 'server@example.invalid')).toBe('server@example.invalid');
    const own = legacy.connection;
    if (own === undefined) throw new Error('missing connection');
    expect(modelAccount({ ...legacy, connection: { ...own, signedIn: true } }, 'server@example.invalid')).toBe('Account not reported');
    expect(modelAccount({ ...legacy, connection: { ...own, hasKey: true } }, 'server@example.invalid')).toBe('API key');
  });

  test('a fallback uses its chosen model and exact chain entry, not the connection default', () => {
    const value = settings();
    value.fallbacks = [{ connection: 'a', model: 'gpt-other' }];
    value.chain.push({ connection: 'a', model: 'gpt-other', used: 0.2, hold: null, active: false });
    expect(modelOrder(value)[1]).toMatchObject({ model: 'gpt-other', row: { model: 'gpt-other', used: 0.2 }, usage: value.usage.a });
  });
});
