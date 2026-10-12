import { accessToken } from './auth.js';
import { AuthError, callBearer, NotFoundError } from './client.js';
import { captureMigrationIdentity, type MigrationIdentity } from './connector-migration-identity.js';
import { MIGRATION_UPDATE, readMigrationPreview, type MigrationPlan, type MigrationSource } from './connector-migration.js';
import { migrationStatusOf, type MigrationAction, type MigrationStatus, type MigrationView } from './connector-migration-status.js';
import { signInOrgConnector } from './org-connectors.js';

export const MIGRATION_UNCERTAIN = 'The migration outcome is uncertain. The request may have reached the agent. Refresh and Reconcile before making another change. No request is retried automatically.';
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
  act: (sourceId: string, action: MigrationAction, selection?: MigrationSelection) => Promise<MigrationSnapshot>;
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
  if (!source.policySupported || source.issues.some((issue) => issue !== 'oauth_sign_in')) throw new Error('Resolve the source blockers shown in the preview before preparing.');
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

function actionAllowed(snapshot: MigrationSnapshot, sourceId: string, action: MigrationAction): void {
  if (action === 'prepare' || action === 'cutover') {
    forwardAllowed(snapshot, sourceId, action);
    return;
  }
  const { status } = actionable(snapshot);
  const migration = status.migrations.find((row) => row.sourceId === sourceId);
  if (migration === undefined && !snapshot.uncertain.includes(sourceId)) throw new Error('Refresh to find this migration first.');
  if (action === 'resolve' && (migration?.reason !== 'requests_uncertain' || migration.uncertainty === null)) throw new Error('Refresh to find the outstanding request fence before confirming it is settled.');
}

function checkSelection(snapshot: MigrationSnapshot, sourceId: string, selection: MigrationSelection | undefined, checkReceipt = false): void {
  if (selection === undefined) return;
  const current = snapshot.status?.migrations.find((row) => row.sourceId === sourceId);
  const sameOperation = (current?.id ?? null) === selection.operationId;
  const sameReceipt = !checkReceipt || current?.uncertainty === selection.uncertainty;
  if (!sameOperation || !sameReceipt) throw new Error('The migration changed since this action was shown. Refresh and review it again.');
}

function actionBody(previous: MigrationStatus | null, action: { sourceId: string; action: MigrationAction } | undefined) {
  if (action === undefined) return {};
  const migration = previous?.migrations.find((row) => row.sourceId === action.sourceId);
  const body = { scope: previous?.scope, ...action, operationId: migration?.id ?? null, ...(action.action === 'resolve' ? { uncertainty: migration?.uncertainty ?? null } : {}) };
  return { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

async function requestStatus(identity: MigrationIdentity, signal: AbortSignal, previous: MigrationStatus | null, action?: { sourceId: string; action: MigrationAction }): Promise<MigrationStatus> {
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
  const run = async <T>(job: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    identity.check();
    if (busy) throw new Error('A migration request is already running. Wait for its result.');
    busy = true;
    const controller = new AbortController();
    const abort = (): void => { controller.abort(); };
    identity.signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, 30_000);
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
  const act = (sourceId: string, action: MigrationAction, selection?: MigrationSelection): Promise<MigrationSnapshot> => run(async (signal) => {
    checkSelection(state, sourceId, selection, action === 'resolve');
    actionAllowed(state, sourceId, action);
    try {
      const status = await requestStatus(identity, signal, state.status, { sourceId, action });
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
      throw new Error(MIGRATION_UNCERTAIN);
    }
  });
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
  return { id: String(++nextDialog), refresh, act, signIn, snapshot, check: identity.check, dispose: identity.dispose };
}
