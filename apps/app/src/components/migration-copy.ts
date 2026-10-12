import type { MigrationIssue } from '@metro-labs/client/api/connector-migration';
import type { MigrationPhase, MigrationReason, MigrationView } from '@metro-labs/client/api/connector-migration-status';

export const MIGRATION_ISSUES: Record<MigrationIssue, string> = {
  invalid_config: 'Blocked: these local settings cannot be safely interpreted. Fix them locally, then Refresh.',
  unsupported_url: 'Blocked: organization connectors require a public HTTPS server. Keep this connector local or change its address before preparing.',
  custom_policy: 'Blocked: these permission rules include names the organization policy validator cannot preserve, or this agent needs an update. Review unsupported tool names without weakening the policy. Do not replace it with a read-only switch.',
  unused_oauth_client: 'This connector saves an OAuth client but is not using OAuth. Confirm which authentication it should use, then recreate its local setup with that method before migrating. Metro will not discard the saved client.',
  oauth_private_resource: 'This OAuth URL may contain private settings. Use a provider-supported public OAuth endpoint without URL credentials, or keep this connector local. Metro will not expose its saved URL in the sign-in page.',
  oauth_sign_in: 'A fresh central sign-in is required. Access and refresh tokens are never copied.',
  header_reentry: 'This older agent cannot transfer the saved key. Update it first. Do not paste credentials into this dialog.',
};

const MIGRATION_PHASES: Record<MigrationPhase, string> = {
  preparing: 'Preparing destination',
  prepared: 'Destination prepared',
  cutover: 'Cutover pending',
  active: 'Organization path active',
  rollback: 'Rollback pending',
  rolled_back: 'Rolled back',
};

export const migrationPhase = (migration: MigrationView): string => migration.phase === 'active' && migration.reason !== null ? 'Organization path needs attention' : MIGRATION_PHASES[migration.phase];

const REASONS: Record<MigrationReason, string> = {
  sign_in: 'Sign in centrally, then choose Reconcile to verify the destination.',
  not_verified: 'The destination is not verified. Choose Reconcile to check it with the server.',
  source_changed: 'The local source changed. Cutover is blocked. Review its current settings and Reconcile, or Roll back.',
  destination_changed: 'The destination or its assignment changed. Inspect the organization connector and assignments, resolve the ownership conflict, then Reconcile. Metro will not delete independently changed or shared access; rollback may remain blocked.',
  assignment_changed: 'The original assignment changed. Inspect the organization connector and assignments, resolve the ownership conflict, then Reconcile. Independently changed assignments, other agents and shared access will not be removed.',
  waiting_for_local: 'Waiting for existing local requests to finish. The source stays fenced during cutover. Choose Reconcile to check again.',
  sync_unavailable: 'Organization sync is unavailable. Restore sync using its separate controls, then Refresh and Reconcile. This dialog changes no sync flags.',
  identity_changed: 'Enrollment or ownership changed. Close this dialog, check the agent identity and reopen it before continuing.',
  rolled_back: 'The migrated path is disabled and the local source is restored. OAuth may need a fresh local sign-in.',
  unavailable: 'The migration is unavailable. Refresh and Reconcile before continuing.',
  requests_uncertain: 'An interrupted vendor request may have completed despite its missing reply. Inspect the vendor first. Confirm requests settled only after checking the outcome; this does not undo or retry the request. The migration remains fenced until you explicitly confirm.',
  unknown: 'The agent reported an unknown blocker. Update if needed, then Refresh and Reconcile. Cutover is blocked.',
};

export function migrationReason(reason: MigrationReason | null, phase: MigrationPhase): string | null {
  if (reason === 'sign_in' && phase === 'rolled_back') return 'The local source is restored, but OAuth needs a fresh local sign-in. The older provider grant may no longer work.';
  return reason === null ? null : REASONS[reason];
}

const canPrepareAgain = (migration: MigrationView, uncertain: boolean): boolean => migration.phase === 'rolled_back' && !uncertain && [null, 'rolled_back', 'sign_in'].includes(migration.reason);

export function migrationControls(migration: MigrationView | undefined, uncertain: boolean) {
  if (migration === undefined) return { prepare: !uncertain, cutover: false, signIn: false, rollback: false, reconcile: uncertain, resolve: false };
  return {
    prepare: canPrepareAgain(migration, uncertain),
    cutover: migration.phase === 'prepared' && migration.reason === null && !uncertain,
    signIn: migration.auth === 'oauth' && migration.phase === 'prepared' && migration.destinationId !== null && migration.reason !== 'requests_uncertain',
    rollback: migration.phase !== 'rolled_back',
    reconcile: true,
    resolve: migration.reason === 'requests_uncertain' && migration.uncertainty !== null,
  };
}

export type MigrationConfirmationAction = 'cutover' | 'rollback' | 'resolve';

export const MIGRATION_CONFIRMATIONS: Record<MigrationConfirmationAction, { title: string; word: string; label: string }> = {
  cutover: { title: 'Switch this connector?', word: 'switch', label: 'Switch connector' },
  rollback: { title: 'Roll back this connector?', word: 'rollback', label: 'Roll back connector' },
  resolve: { title: 'Confirm requests settled?', word: 'settled', label: 'Confirm requests settled' },
};

export function migrationConfirmation(name: string, action: MigrationConfirmationAction): string[] {
  if (action === 'resolve') return [
    `Inspect ${name} at the vendor before confirming. An outstanding request may have committed despite an interrupted or missing reply. Check its actual outcome first.`,
    'This confirmation does not undo or retry that request. It only clears the migration fence after no local sessions are running; the server refuses while a local session is still running.',
    'After confirmation, separately choose Reconcile, Switch to organization or Roll back. This confirmation does not activate or roll back the migration.',
  ];
  if (action === 'rollback') return [
    `Roll back only ${name}? This disables its migrated organization path, removes only the original assignment created by this migration, and restores the local source.`,
    'The organization destination is kept. Shared assignments, other agents and other connectors are not deleted or changed.',
    'OAuth may require a fresh local sign-in. Saved tokens are not a guaranteed recovery. If interrupted, Refresh and Reconcile; do not assume rollback finished.',
  ];
  return [
    `Switch only ${name} to its verified organization destination? The server checks readiness again, blocks new local requests, then waits for existing local requests to finish before switching.`,
    'The source relay ID and plugin key stay the same. Unmigrated connectors, their default local path and fallback behavior are unaffected. No environment variables or sync flags change.',
    'If cutover is pending or interrupted, the source stays fenced. Refresh and Reconcile to confirm the result, or explicitly Roll back. Only the server can confirm activation.',
  ];
}
