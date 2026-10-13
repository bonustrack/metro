import type { MigrationIssue } from '@metro-labs/client/api/connector-migration';
import type { MigrationPhase, MigrationReason, MigrationView } from '@metro-labs/client/api/connector-migration-status';

export const MIGRATION_ISSUES: Record<MigrationIssue, string> = {
  invalid_config: 'Blocked: these local settings cannot be read safely. Fix them, then Refresh.',
  unsupported_url: 'Blocked: organization connectors need a public HTTPS server. Keep this one local or change its address.',
  custom_policy: 'Blocked: some rules cannot carry over, or this agent needs an update. Fix the tool names without weakening the policy. Do not replace it with a read-only switch.',
  unused_oauth_client: 'This connector saves an OAuth client but does not use OAuth. Set it up again with the right sign-in first. Metro will not discard the saved client.',
  oauth_private_resource: 'Older Metro migration only accepts OAuth at the public origin or /mcp path. Update this agent first. This is not about a secret in the URL.',
  oauth_sign_in: 'No OAuth login to move. Sign in locally first, or sign in centrally.',
  oauth_unsupported: 'Blocked: this OAuth login cannot move. Keep it local or sign in separately. Metro will not make a new one for you.',
  header_reentry: 'This agent is too old to move the saved key. Update it first. Never paste keys here.',
};

const MIGRATION_PHASES: Record<MigrationPhase, string> = {
  recovering: 'Recovering local sign-in',
  freezing: 'Pausing and draining local requests',
  preparing: 'Preparing destination',
  prepared: 'Destination prepared',
  cutover: 'Cutover pending',
  active: 'Organization path active',
  rollback: 'Rollback pending',
  rolled_back: 'Rolled back',
};

export const migrationPhase = (migration: MigrationView): string => migration.phase === 'active' && migration.reason !== null ? 'Organization path needs attention' : MIGRATION_PHASES[migration.phase];

const REASONS: Record<MigrationReason, string> = {
  sign_in: 'Sign in centrally, then choose Reconcile to check.',
  not_verified: 'The destination is not checked yet. Choose Reconcile.',
  source_changed: 'The local connector changed, so the switch is blocked. Review it and Reconcile, or Roll back.',
  destination_changed: 'The destination or its assignment changed. Fix the conflict in organization connectors, then Reconcile. Metro will not delete independently changed or shared access, so rollback may stay blocked.',
  assignment_changed: 'The original assignment changed. Fix the conflict in organization connectors, then Reconcile. Other agents and shared access stay untouched.',
  waiting_for_local: 'Waiting for local requests to finish. The source stays paused. Choose Reconcile to check again.',
  sync_unavailable: 'Organization sync is unavailable. Turn it back on in its own settings, then Refresh and Reconcile.',
  identity_changed: 'Enrollment or ownership changed. Close this, check the agent, then open it again.',
  rolled_back: 'Rolled back: the local connector is back. OAuth may need a fresh local sign-in.',
  unavailable: 'The migration is unavailable. Refresh and Reconcile before continuing.',
  requests_uncertain: 'A request may have gone through even though no reply came. Check at the vendor first, then confirm it settled. Nothing is undone or retried, and the move stays paused until you confirm.',
  refresh_uncertain: 'A login refresh may have failed. The organization owns this login now: sign in centrally to fix it. Old local tokens cannot come back.',
  local_refresh_uncertain: 'A local refresh may have changed the token. Check open requests at the vendor, then choose Recover local sign-in to cancel the move and sign in locally again.',
  finish_forward: 'The organization owns this OAuth login now. Retry to finish, or sign in centrally. It cannot roll back.',
  unsupported_grant: 'This login cannot move as it is. Keep it local or sign in separately.',
  unknown: 'The agent reported an unknown problem. Update if needed, then Refresh and Reconcile. Cutover is blocked.',
};

export function migrationReason(reason: MigrationReason | null, phase: MigrationPhase): string | null {
  if (reason === 'sign_in' && phase === 'rolled_back') return 'The local connector is back, but OAuth needs a fresh local sign-in.';
  return reason === null ? null : REASONS[reason];
}

const canPrepareAgain = (migration: MigrationView, uncertain: boolean): boolean => migration.phase === 'rolled_back' && !uncertain && [null, 'rolled_back', 'sign_in'].includes(migration.reason);

const rollbackAllowed = (migration: MigrationView): boolean => migration.phase !== 'rolled_back' && migration.grantImported !== true && migration.reason !== 'local_refresh_uncertain';

export function migrationControls(migration: MigrationView | undefined, uncertain: boolean) {
  if (migration === undefined) return { prepare: !uncertain, cutover: false, signIn: false, rollback: false, reconcile: uncertain, resolve: false };
  return {
    prepare: canPrepareAgain(migration, uncertain),
    cutover: migration.phase === 'prepared' && migration.reason === null && !uncertain,
    signIn: migration.auth === 'oauth' && migration.phase === 'prepared' && migration.destinationId !== null && migration.reason !== 'requests_uncertain',
    rollback: rollbackAllowed(migration),
    reconcile: true,
    resolve: (migration.reason === 'requests_uncertain' || migration.reason === 'local_refresh_uncertain') && migration.uncertainty !== null,
  };
}

export type MigrationConfirmationAction = 'cutover' | 'rollback' | 'resolve' | 'recover';

export const MIGRATION_CONFIRMATIONS: Record<MigrationConfirmationAction, { title: string; word: string; label: string }> = {
  recover: { title: 'Recover local sign-in?', word: 'recover', label: 'Discard uncertain grant' },
  cutover: { title: 'Switch this connector?', word: 'switch', label: 'Switch connector' },
  rollback: { title: 'Roll back this connector?', word: 'rollback', label: 'Roll back connector' },
  resolve: { title: 'Confirm requests settled?', word: 'settled', label: 'Confirm requests settled' },
};

export function migrationConfirmation(name: string, action: MigrationConfirmationAction): string[] {
  if (action === 'recover') return [
    `Check open requests for ${name} at the vendor first. The local refresh reply was lost, so the saved login may be stale.`,
    'This cancels the move if the organization has not taken over yet, and drops the local login. Sign in locally after. Nothing is retried.',
  ];
  if (action === 'resolve') return [
    `Inspect ${name} at the vendor first. A request may have committed even without a reply.`,
    'This does not undo or retry it. It only lifts the pause once no local sessions are running.',
    'Then separately choose Reconcile, Switch to organization or Roll back.',
  ];
  if (action === 'rollback') return [
    `Roll back only ${name}? This stops using the organization connector, removes only the original assignment created by this migration and brings the local connector back.`,
    'The organization destination is kept. Shared assignments, other agents and connectors stay as they are.',
    'OAuth may need a fresh local sign-in. If interrupted, Refresh and Reconcile: do not assume rollback finished.',
  ];
  return [
    `Switch only ${name} to the organization? The server checks again, stops new local requests and waits for existing local requests to finish.`,
    'The source relay ID and plugin key stay the same. Unmigrated connectors are not touched. No environment variables or sync flags change.',
    'If the switch stops halfway, the source stays paused. Refresh and Reconcile to check, or Roll back.',
  ];
}
