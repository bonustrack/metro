import { describe, expect, test } from 'bun:test';
import { MIGRATION_CONFIRMATIONS, MIGRATION_ISSUES, migrationConfirmation, migrationControls, migrationPhase, migrationReason } from '../src/components/migration-copy.js';
import type { MigrationView } from '@metro-labs/client/api/connector-migration-status';

describe('migration safety copy', () => {
  test('cutover confirmation is per connector and does not imply all local connectors move', () => {
    const copy = migrationConfirmation('Calendar', 'cutover').join(' ');
    expect(copy).toContain('Switch only Calendar');
    expect(copy).toContain('waits for existing local requests');
    expect(copy).toContain('source relay ID and plugin key');
    expect(copy).toContain('Unmigrated connectors');
    expect(copy).toContain('No environment variables or sync flags change');
    expect(copy).toContain('source stays fenced');
  });

  test('rollback confirmation never implies deleting the destination or shared access', () => {
    const copy = migrationConfirmation('Calendar', 'rollback').join(' ');
    expect(copy).toContain('only the original assignment created by this migration');
    expect(copy).toContain('destination is kept');
    expect(copy).toContain('Shared assignments');
    expect(copy).toContain('fresh local sign-in');
    expect(copy).toContain('do not assume rollback finished');
  });

  test('OAuth signin resolution distinguishes preparation from local recovery', () => {
    expect(migrationReason('sign_in', 'prepared')).toContain('Sign in centrally');
    expect(migrationReason('sign_in', 'rolled_back')).toContain('fresh local sign-in');
    expect(migrationReason(null, 'prepared')).toBeNull();
    expect(migrationReason('unknown', 'prepared')).toContain('Cutover is blocked');
  });

  test('an empty successful Reconcile restores only the explicit preparation action', () => {
    expect(migrationControls(undefined, true)).toEqual({ prepare: false, cutover: false, signIn: false, rollback: false, reconcile: true, resolve: false });
    expect(migrationControls(undefined, false)).toEqual({ prepare: true, cutover: false, signIn: false, rollback: false, reconcile: false, resolve: false });
  });

  test('only server-confirmed prepared readiness exposes cutover, pending stages keep recovery actions', () => {
    const migration: MigrationView = { id: 'migration01', sourceId: 'source00001', destinationId: 'central0001', name: 'Calendar', phase: 'prepared', auth: 'oauth', reason: 'sign_in', uncertainty: null };
    expect(migrationControls(migration, false)).toMatchObject({ cutover: false, signIn: true, reconcile: true, rollback: true });
    expect(migrationControls({ ...migration, reason: null }, false).cutover).toBe(true);
    expect(migrationControls({ ...migration, reason: null }, true).cutover).toBe(false);
    for (const phase of ['preparing', 'cutover', 'active', 'rollback'] as const) expect(migrationControls({ ...migration, phase, reason: null }, false)).toMatchObject({ prepare: false, cutover: false, rollback: true, reconcile: true });
    expect(migrationControls({ ...migration, phase: 'rolled_back' }, false)).toMatchObject({ prepare: true, rollback: false, cutover: false });
  });

  test('request fences require a separate typed settled confirmation and vendor inspection', () => {
    const migration: MigrationView = { id: 'migration01', sourceId: 'source00001', destinationId: 'central0001', name: 'Calendar', phase: 'cutover', auth: 'oauth', reason: 'requests_uncertain', uncertainty: 'a'.repeat(64) };
    expect(migrationControls(migration, false)).toMatchObject({ resolve: true, cutover: false, prepare: false });
    expect(migrationControls({ ...migration, uncertainty: null }, false).resolve).toBe(false);
    expect(migrationControls({ ...migration, reason: null }, false).resolve).toBe(false);
    expect(MIGRATION_CONFIRMATIONS.resolve.word).toBe('settled');
    const copy = migrationConfirmation('Calendar', 'resolve').join(' ');
    expect(copy).toContain('Inspect Calendar at the vendor');
    expect(copy).toContain('may have committed');
    expect(copy).toContain('does not undo or retry');
    expect(copy).toContain('no local sessions are running');
    expect(copy).toContain('separately choose Reconcile');
    expect(migrationPhase({ ...migration, phase: 'active' })).toBe('Organization path needs attention');
  });

  test('manual OAuth and policy blockers never recommend discarding settings or weakening access', () => {
    expect(MIGRATION_ISSUES.unused_oauth_client).toContain('Metro will not discard the saved client');
    expect(MIGRATION_ISSUES.custom_policy).toContain('without weakening');
    expect(MIGRATION_ISSUES.custom_policy).toContain('Do not replace it with a read-only switch');
    expect(migrationReason('destination_changed', 'rollback')).toContain('will not delete independently changed or shared access');
  });
});


test('legacy URL restrictions are an update requirement, not a detected secret', () => {
  expect(MIGRATION_ISSUES.oauth_private_resource).toContain('Older Metro migration only accepts');
  expect(MIGRATION_ISSUES.oauth_private_resource).toContain('Update this agent first');
  expect(MIGRATION_ISSUES.oauth_private_resource).not.toContain('may contain private settings');
});
