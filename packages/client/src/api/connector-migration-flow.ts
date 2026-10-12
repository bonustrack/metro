import { accessToken } from './auth.js';
import { AuthError, callBearer, NotFoundError } from './client.js';
import { captureMigrationIdentity, type MigrationIdentity } from './connector-migration-identity.js';
import { MIGRATION_UPDATE, MIGRATION_RESOURCE_UPDATE, readMigrationPreview, type MigrationPlan, type MigrationSource } from './connector-migration.js';
import { migrationStatusOf, type MigrationAction, type MigrationStatus, type MigrationView } from './connector-migration-status.js';
import { signInOrgConnector } from './org-connectors.js';

export const MIGRATION_UNCERTAIN = 'The migration outcome is uncertain. The request may have reached the agent. Refresh and Reconcile before making another change. No request is retried automatically.';
export const MIGRATION_PUBLIC_RESOURCE_REQUIRED = "Enter the provider's public OAuth resource. Roll back this preparation, then prepare again with that public value; never enter credentials.";
const READ_FAILED = 'Could not refresh migration status. Last confirmed progress is shown. Refresh and Reconcile before continuing.';
let nextDialog = 0;

export interface MigrationSnapshot {
  plan: MigrationPlan | null;
  status: MigrationStatus | null;
  previewError: string | null;
  statusError: string | null;
  uncertain: string[];
}

export interface MigrationSelection {
  operationId: string | null;
  uncertainty: string | null;
}

export interface ConnectorMigration {
  id: string;
  refresh: () => Promise<MigrationSnapshot>;
  act: (sourceId: string, action: MigrationAction, selection?: MigrationSelection, oauthResource?: string) => Promise<MigrationSnapshot>;
  moveAll: (progress: () => void) => Promise<MigrationSnapshot>;
  signIn: (sourceId: string, selection?: MigrationSelection) => Promise<string>;
  snapshot: () => MigrationSnapshot;
  check: () => void;
  dispose: () => void;
}

function actionable(snapshot: MigrationSnapshot, requireSync = false): { plan: MigrationPlan; status: MigrationStatus } {
  if (snapshot.plan?.preview.migrationSupported !== true) throw new Error(MIGRATION_UPDATE);
  if (snapshot.status === null || snapshot.statusError !== null) throw new Error('Refresh migration status before continuing.');
  if (!snapshot.status.enrolled || (requireSync && !snapshot.status.enabled)) throw new Error('Organization sync and enrollment are required for preparation and cutover. This dialog does not change either setting.');
  return { plan: snapshot.plan, status: snapshot.status };
}

function prepareAllowed(source: MigrationSource, migration: MigrationView | undefined): void {
  if (migration !== undefined && (migration.phase !== 'rolled_back' || ![null, 'sign_in', 'rolled_back'].includes(migration.reason))) throw new Error('This connector already has migration progress or a blocker. Reconcile it instead.');
  if (!source.policySupported || source.issues.some((issue) => !['oauth_sign_in', 'oauth_unsupported'].includes(issue))) throw new Error('Resolve the source blockers shown in the preview before preparing.');
}

function forwardAllowed(snapshot: MigrationSnapshot, sourceId: string, action: 'prepare' | 'cutover'): void {
  const { plan, status } = actionable(snapshot, true);
  if (snapshot.uncertain.includes(sourceId)) throw new Error(MIGRATION_UNCERTAIN);
  const source = plan.rows.find((row) => row.source.id === sourceId)?.source;
  if (snapshot.previewError !== null || source === undefined) throw new Error('Refresh the source preview before continuing.');
  const migration = status.migrations.find((row) => row.sourceId === sourceId);
  if (action === 'prepare') {
    prepareAllowed(source, migration);
    return;
  }
  if (migration?.phase !== 'prepared' || migration.reason !== null) throw new Error('Reconcile until the agent confirms the destination is ready before switching.');
}

function moveAllowed(snapshot: MigrationSnapshot, sourceId: string): void {
  const { plan } = actionable(snapshot, true);
  if (plan.preview.moveAllSupported !== true) throw new Error('Update this agent before using Move all.');
  const source = plan.rows.find((row) => row.source.id === sourceId)?.source;
  if (snapshot.previewError !== null || source === undefined || !source.policySupported || source.issues.length !== 0) throw new Error('Resolve this connector’s preview blocker before moving it.');
}

function settlementAvailable(migration: MigrationView | undefined): boolean {
  return migration !== undefined && ['requests_uncertain', 'local_refresh_uncertain'].includes(migration.reason ?? '') && migration.uncertainty !== null;
}

function actionAllowed(snapshot: MigrationSnapshot, sourceId: string, action: MigrationAction): void {
  if (action === 'move') { moveAllowed(snapshot, sourceId); return; }
  if (action === 'prepare' || action === 'cutover') {
    forwardAllowed(snapshot, sourceId, action);
    return;
  }
  const { status } = actionable(snapshot);
  const migration = status.migrations.find((row) => row.sourceId === sourceId);
  if (migration === undefined && !snapshot.uncertain.includes(sourceId)) throw new Error('Refresh to find this migration first.');
  if (action === 'resolve' && !settlementAvailable(migration)) throw new Error('Refresh to find the outstanding request fence before confirming it is settled.');
}

function checkSelection(snapshot: MigrationSnapshot, sourceId: string, selection: MigrationSelection | undefined, checkReceipt = false): void {
  if (selection === undefined) return;
  const current = snapshot.status?.migrations.find((row) => row.sourceId === sourceId);
  const sameOperation = (current?.id ?? null) === selection.operationId;
  const sameReceipt = !checkReceipt || current?.uncertainty === selection.uncertainty;
  if (!sameOperation || !sameReceipt) throw new Error('The migration changed since this action was shown. Refresh and review it again.');
}

function resourceBody(state: MigrationSnapshot, sourceId: string, action: MigrationAction, value: string | undefined): { oauthResource?: string } {
  const resource = value?.trim();
  if (!resource) return {};
  if (state.plan?.preview.oauthResourceSupported !== true) throw new Error(MIGRATION_RESOURCE_UPDATE);
  const source = state.plan?.rows.find((row) => row.source.id === sourceId)?.source;
  if (action !== 'prepare' || source?.auth !== 'oauth') throw new Error('Only OAuth preparation accepts a public resource.');
  return { oauthResource: resource };
}

function actionFailure(error: unknown, action: MigrationAction): Error {
  if (action === 'prepare' && error instanceof Error && error.message === MIGRATION_PUBLIC_RESOURCE_REQUIRED) return new Error(MIGRATION_PUBLIC_RESOURCE_REQUIRED);
  return new Error(MIGRATION_UNCERTAIN);
}

function actionBody(previous: MigrationStatus | null, action: { sourceId: string; action: MigrationAction; oauthResource?: string } | undefined) {
  if (action === undefined) return {};
  const migration = previous?.migrations.find((row) => row.sourceId === action.sourceId);
  const body = { scope: previous?.scope, ...action, operationId: migration?.id ?? null, ...(action.action === 'resolve' ? { uncertainty: migration?.uncertainty ?? null } : {}) };
  return { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

async function requestStatus(identity: MigrationIdentity, signal: AbortSignal, previous: MigrationStatus | null, action?: { sourceId: string; action: MigrationAction; oauthResource?: string }): Promise<MigrationStatus> {
  const token = await accessToken();
  identity.check();
  if (token === null) throw new AuthError('Sign in again as an organization admin.');
  const checkAccount = (): void => {
    identity.check();
    if (signal.aborted) throw new Error(MIGRATION_UNCERTAIN);
  };
  const body = actionBody(previous, action);
  const answer = await callBearer({ method: action === undefined ? 'GET' : 'POST', base: `${identity.base}/api/connectors/migrations`, ...body, signal, checkAccount }, token);
  checkAccount();
  return migrationStatusOf(answer, identity, previous?.scope ?? null);
}

function safeReadError(error: unknown, fallback: string): string {
  if (error instanceof NotFoundError || (error instanceof Error && error.message === MIGRATION_UPDATE)) return MIGRATION_UPDATE;
  if (error instanceof AuthError) return 'Sign in again as an organization admin, then reopen this dialog.';
  return fallback;
}

export function createConnectorMigration(onInvalidate?: () => void): ConnectorMigration {
  const identity = captureMigrationIdentity(onInvalidate);
  let state: MigrationSnapshot = { plan: null, status: null, previewError: null, statusError: null, uncertain: [] };
  let busy = false;
  const snapshot = (): MigrationSnapshot => { identity.check(); return state; };
  const run = async <T>(job: (signal: AbortSignal) => Promise<T>, timeoutMs = 30_000): Promise<T> => {
    identity.check();
    if (busy) throw new Error('A migration request is already running. Wait for its result.');
    busy = true;
    const controller = new AbortController();
    const abort = (): void => { controller.abort(); };
    identity.signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, timeoutMs);
    try {
      const result = await job(controller.signal);
      identity.check();
      return result;
    } catch (error) {
      identity.check();
      throw error;
    } finally {
      clearTimeout(timer);
      identity.signal.removeEventListener('abort', abort);
      busy = false;
    }
  };
  const refresh = (): Promise<MigrationSnapshot> => run(async (signal) => {
    try {
      const plan = await readMigrationPreview(identity, signal);
      identity.check();
      state = { ...state, plan, previewError: null };
    } catch (error) {
      identity.check();
      state = { ...state, previewError: safeReadError(error, 'Could not refresh the source preview. Last confirmed settings are shown; preparation and cutover are blocked.') };
    }
    try {
      const status = await requestStatus(identity, signal, state.status);
      state = { ...state, status, statusError: null };
    } catch (error) {
      identity.check();
      state = { ...state, statusError: safeReadError(error, READ_FAILED) };
    }
    return snapshot();
  });
  const act = (sourceId: string, action: MigrationAction, selection?: MigrationSelection, oauthResource?: string): Promise<MigrationSnapshot> => run(async (signal) => {
    checkSelection(state, sourceId, selection, action === 'resolve');
    actionAllowed(state, sourceId, action);
    const resource = resourceBody(state, sourceId, action, oauthResource);
    try {
      const status = await requestStatus(identity, signal, state.status, { sourceId, action, ...resource });
      if (action !== 'reconcile' && !status.migrations.some((row) => row.sourceId === sourceId)) throw new Error(MIGRATION_UNCERTAIN);
      state = { ...state, status, statusError: null, uncertain: state.uncertain.filter((id) => id !== sourceId) };
      return snapshot();
    } catch (error) {
      identity.check();
      state = { ...state, uncertain: [...new Set([...state.uncertain, sourceId])] };
      if (error instanceof NotFoundError) {
        state = { ...state, statusError: MIGRATION_UPDATE };
        throw new Error(MIGRATION_UPDATE);
      }
      throw actionFailure(error, action);
    }
  }, action === 'move' ? 180_000 : 30_000);
  const signIn = (sourceId: string, selection?: MigrationSelection): Promise<string> => run(async (signal) => {
    checkSelection(state, sourceId, selection);
    const { status } = actionable(state, true);
    if (state.uncertain.includes(sourceId)) throw new Error(MIGRATION_UNCERTAIN);
    const migration = status.migrations.find((row) => row.sourceId === sourceId);
    if (migration?.auth !== 'oauth' || migration.destinationId === null || migration.phase !== 'prepared') throw new Error('Refresh to find a prepared OAuth destination first.');
    if (migration.reason === 'requests_uncertain') throw new Error('Inspect the vendor and confirm requests settled before starting a new sign-in.');
    const check = (): void => { identity.check(); if (signal.aborted) throw new Error('The sign-in request ended.'); };
    try {
      const url = await signInOrgConnector(migration.destinationId, check, signal);
      check();
      return url;
    } catch {
      identity.check();
      throw new Error('The central sign-in could not be confirmed. Refresh and Reconcile before trying again.');
    }
  });
  const moveAll = async (progress: () => void): Promise<MigrationSnapshot> => {
    const { plan } = actionable(state, true);
    if (plan.preview.moveAllSupported !== true) throw new Error('Update this agent before using Move all.');
    const ids = plan.rows.filter(({ source }) => source.policySupported && source.issues.length === 0).map(({ source }) => source.id);
    for (const sourceId of ids) {
      identity.check();
      if (state.status?.migrations.some((row) => row.sourceId === sourceId && row.phase === 'active' && row.reason === null)) continue;
      try { await act(sourceId, 'move'); } catch { identity.check(); await refresh(); }
      identity.check();
      progress();
    }
    return snapshot();
  };
  return { id: String(++nextDialog), refresh, act, moveAll, signIn, snapshot, check: identity.check, dispose: identity.dispose };
}
