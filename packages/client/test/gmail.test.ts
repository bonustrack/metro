import { describe, expect, test } from 'bun:test';
import { carryForward, groupAccounts } from '../src/api/accounts.js';
import { gmailAccess, gmailConnectFields, gmailForm, gmailUpgradeFields } from '../src/api/gmail.js';

const credentials = { clientId: ' synthetic-client ', clientSecret: ' synthetic-secret ', mailbox: ' person@example.com ' };

const requiredFields = (managed: boolean, mode: 'managed' | 'byo'): string[] =>
  gmailForm(managed, mode).fields.filter((field) => field.optional !== true).map((field) => field.key);

describe('Gmail connection capability', () => {
  test('managed Gmail needs no key and only offers an optional mailbox', () => {
    const form = gmailForm(true, 'managed');
    expect(form.fields.map((field) => [field.key, field.optional])).toEqual([['mailbox', true]]);
    expect(requiredFields(true, 'managed')).toEqual([]);
    expect(form.hint).toContain('read-only');
    expect(form.hint).toContain('cannot send');
    expect(form.hint).toContain('starts blocked');
    expect(form.links).toEqual([]);
    expect(gmailConnectFields(true, 'managed', credentials)).toEqual({ mode: 'managed', sendEnabled: 'false', mailbox: 'person@example.com' });
    expect(gmailConnectFields(true, 'managed', {})).toEqual({ mode: 'managed', sendEnabled: 'false' });
  });

  test('advanced BYO still requires both credentials and starts read-only', () => {
    expect(requiredFields(true, 'byo')).toEqual(['clientId', 'clientSecret']);
    expect(gmailForm(true, 'byo').fields.find((field) => field.key === 'clientSecret')?.secret).toBe(true);
    expect(gmailForm(true, 'byo').hint).toContain('read-only');
    expect(gmailConnectFields(true, 'byo', credentials)).toEqual({ mode: 'byo', sendEnabled: 'false', clientId: 'synthetic-client', clientSecret: 'synthetic-secret', mailbox: 'person@example.com' });
  });

  test('an older daemon keeps BYO and warns that sending scope may be requested', () => {
    expect(requiredFields(false, 'managed')).toEqual(['clientId', 'clientSecret']);
    expect(gmailForm(false, 'managed').hint).toContain('Update Metro');
    expect(gmailForm(false, 'managed').hint).toContain('may also request permission to send');
    expect(gmailForm(false, 'managed').hint).not.toContain('Google grants read-only');
    expect(gmailConnectFields(false, 'managed', credentials)).toEqual({ mode: 'byo', sendEnabled: 'false', clientId: 'synthetic-client', clientSecret: 'synthetic-secret', mailbox: 'person@example.com' });
  });

  test('sending upgrade identifies only the stored account and never changes Metro policy', () => {
    expect(gmailUpgradeFields('existing-account')).toEqual({ accountId: 'existing-account', sendEnabled: 'true', mode: 'upgrade' });
    expect(gmailConnectFields(true, 'managed', { policy: 'allow', sendEnabled: 'true', accountId: 'other' })).toEqual({ mode: 'managed', sendEnabled: 'false' });
  });
});

describe('Gmail access settings', () => {
  test('read-only accounts can authorize sending without changing Metro permission', () => {
    expect(gmailAccess(true, false)).toMatchObject({ title: 'Read-only', upgrade: true });
    expect(gmailAccess(true, false).note).toContain('first');
    expect(gmailAccess(true, true)).toMatchObject({ title: 'Sending authorized', upgrade: false });
    expect(gmailAccess(true, true).note).toContain('Metro Write permission');
  });

  test('unknown or old-daemon authorization is not mislabelled read-only', () => {
    expect(gmailAccess(false, false)).toMatchObject({ title: 'Google authorization', upgrade: false });
    expect(gmailAccess(false, false).note).toContain('Update Metro');
    expect(gmailAccess(true, null)).toMatchObject({ title: 'Google authorization', upgrade: false });
    expect(gmailAccess(true, undefined)).toMatchObject({ title: 'Google authorization', upgrade: false });
  });
});

describe('Gmail account metadata', () => {
  test('safe booleans are typed metadata, not generic fields', () => {
    const rows = groupAccounts({ gmail: [{ id: 'one', sendEnabled: false, managed: true }, { id: 'two', sendEnabled: true, managed: false }] })[0]?.rows;
    expect(rows?.[0]).toMatchObject({ sendEnabled: false, managed: true });
    expect(rows?.[1]).toMatchObject({ sendEnabled: true, managed: false });
    expect(rows?.[0]?.fields).toEqual([{ label: 'id', value: 'one' }]);
  });

  test('an unavailable train keeps known authorization and managed-delete warnings', () => {
    const before = groupAccounts({ gmail: [{ id: 'one', sendEnabled: true, managed: true }] });
    const missing = groupAccounts({ gmail: [{ id: 'one', enabled: false }] });
    expect(carryForward(missing, before, ['gmail'])[0]?.rows[0]).toMatchObject({ sendEnabled: true, managed: true, enabled: false });
    const fresh = groupAccounts({ gmail: [{ id: 'one', sendEnabled: false, managed: false }] });
    expect(carryForward(fresh, before, ['gmail'])[0]?.rows[0]).toMatchObject({ sendEnabled: false, managed: false });
  });

  test('missing or malformed metadata stays unknown, never read-only', () => {
    const rows = groupAccounts({ gmail: [{ id: 'one' }, { id: 'two', sendEnabled: 'false', managed: 'true' }] })[0]?.rows;
    for (const row of rows ?? []) expect(row).toMatchObject({ sendEnabled: null, managed: null });
  });
});
