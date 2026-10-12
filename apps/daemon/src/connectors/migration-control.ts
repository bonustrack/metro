import { newId } from '@metro-labs/core/ids';
import { log } from '@metro-labs/core/log';
import type { ConnectorSyncStatus } from '@metro-labs/core/connector-sync';
import { ApiError } from '@metro-labs/http/api-error';
import { publicOAuthResource } from '@metro-labs/http/connector-public-url';
import type { DeliverySnapshot } from '@metro-labs/http/connector-delivery';
import { migrationResponseOf, sealConnectorMigration, type MigrationResponse, type MigrationView as RemoteMigration } from '@metro-labs/http/connector-migration';
import { agentsDir } from '../agents/files.js';
import { readAgentKey, type AgentKey } from './agent-key.js';
import { agentCall, METRO_API, MetroApiRefusal, type MetroApi } from './metro-api.js';
import { migrationSource } from './migration-preview.js';
import { MigrationBlocked, migrationPayload } from './migration-source.js';
import { localMigrationIdle } from './migration-guard.js';
import { migrationUncertaintyReceipt, migrationRefreshUncertain, migrationOperationsIdle, resolveMigrationUncertainty } from './migration-operations.js';
import { flushMigrationSource, localRollbackMigrationSource } from './store.js';
import { freshOrgConnectors, orgConnectorMigrationIdle, orgConnectorSyncStatus, refreshOrgConnectorRuntime } from './org-sync-watch.js';
import { migrationRecord, migrationRecords, saveMigration, type MigrationRecord } from './migration-state.js';

export type MigrationAction = 'move' | 'prepare' | 'reconcile' | 'cutover' | 'rollback' | 'resolve';
interface Context { key: AgentKey; owner: string; agentId: string; scope: string }
export interface MigrationView extends Pick<MigrationRecord, 'id' | 'sourceId' | 'name' | 'destinationId' | 'phase' | 'auth' | 'reason'> {
  uncertainty: string | null;
  move: boolean;
  grantImported: boolean;
}
export interface MigrationStatus {
  scope: string;
  owner: string | null;
  agentId: string | null;
  enabled: boolean;
  enrolled: boolean;
  migrations: MigrationView[];
}

interface MigrationDeps {
  dir?: string;
  api?: MetroApi;
  status?: () => ConnectorSyncStatus;
  key?: () => AgentKey | null;
  fresh?: () => Promise<DeliverySnapshot>;
  changed?: () => void;
  localIdle?: (id: string) => boolean;
  orgIdle?: (id: string) => boolean;
  restore?: (id: string, oauth: boolean) => void;
}

const conflict = (message: string): ApiError => new ApiError(message, 409);
const uncertain = (): ApiError => new ApiError('The migration request was not confirmed. Refresh and reconcile this connector before trying another action; an interrupted request may already have reached Metro.', 503);
const viewOf = ({ id, sourceId, name, destinationId, phase, auth, reason, move, grantImported }: MigrationRecord, uncertainty: string | null): MigrationView => ({ id, sourceId, name, destinationId, phase, auth, reason, uncertainty, move: move === true, grantImported: grantImported === true });
const reasons: Record<RemoteMigration['readiness'], string | null> = { pending: 'not_verified', ready: null, signin: 'sign_in', changed: 'destination_changed', unavailable: 'unavailable', refresh_uncertain: 'refresh_uncertain' };
const samePolicy = (a: MigrationRecord['policy'], b: MigrationRecord['policy']): boolean =>
  (a.read ?? 'allow') === (b.read ?? 'allow') && (a.write ?? 'allow') === (b.write ?? 'allow') && JSON.stringify(Object.entries(a.tools ?? {}).sort()) === JSON.stringify(Object.entries(b.tools ?? {}).sort());

const grantTransfer = (record: MigrationRecord): boolean => record.move === true && record.auth === 'oauth';
const upgrading = (record: MigrationRecord, remote: RemoteMigration): boolean => grantTransfer(record) && remote.grantImported !== true;
const canUpgrade = (record: MigrationRecord): boolean => record.move !== true && ['preparing', 'prepared'].includes(record.phase);

function checkResponse(record: MigrationRecord, remote: RemoteMigration): void {
  if (remote.operationId !== record.id || remote.sourceId !== record.sourceId || (record.destinationId !== null && remote.destinationId !== record.destinationId)) throw uncertain();
  if (remote.sourceStamp === null || remote.sourceStamp === record.sourceStamp || upgrading(record, remote)) return;
  throw conflict('The prepared destination no longer matches this local connector. Reconcile its current operation before continuing.');
}

function callFailure(error: unknown, action: string): ApiError {
  if (error instanceof MetroApiRefusal && error.code === 'migration_conflict') return new MigrationBlocked('destination_changed', 'The destination already has credentials, a name conflict or changed settings. Inspect it and reconcile; Metro will not overwrite credentials or create a duplicate.');
  if (action === 'prepare' && error instanceof MetroApiRefusal && error.upstreamStatus === 400 && error.code === 'oauth_resource_required') {
    return new ApiError("Enter the provider's public OAuth resource. Roll back this preparation, then prepare again with that public value; never enter credentials.", 400);
  }
  return uncertain();
}

function received(record: MigrationRecord, snapshot: DeliverySnapshot): boolean {
  const delivered = snapshot.connectors.find((row) => row.id === record.destinationId);
  return delivered?.state === 'ready' && delivered.name === record.name && samePolicy(delivered.policy, record.policy);
}

export class ConnectorMigrations {
  private readonly dir: string;
  private readonly api: MetroApi;
  private running = false;

  constructor(private readonly deps: MigrationDeps = {}) {
    this.dir = deps.dir ?? agentsDir();
    this.api = deps.api ?? METRO_API;
  }

  private syncStatus(): ConnectorSyncStatus { return (this.deps.status ?? orgConnectorSyncStatus)(); }
  private key(): AgentKey | null { return this.deps.key === undefined ? readAgentKey(this.dir) : this.deps.key(); }
  private changed(): void { (this.deps.changed ?? refreshOrgConnectorRuntime)(); }
  private localIdle(id: string): boolean { return this.deps.localIdle?.(id) ?? localMigrationIdle(id, this.dir); }
  private orgIdle(id: string): boolean { return (this.deps.orgIdle ?? orgConnectorMigrationIdle)(id); }

  status(): MigrationStatus {
    const { scope, owner, agentId, enabled, enrolled } = this.syncStatus();
    const keyId = this.key()?.keyId;
    const migrations = migrationRecords(this.dir).filter((row) => row.owner === owner).map((row) => {
      const uncertainty = migrationUncertaintyReceipt(row.sourceId, this.dir);
      const reason = uncertainty === null ? row.reason : migrationRefreshUncertain(row.sourceId, this.dir) ? 'local_refresh_uncertain' : 'requests_uncertain';
      return viewOf({ ...row, reason: row.agentId !== agentId || row.keyId !== keyId ? 'identity_changed' : reason }, uncertainty);
    });
    return { scope, owner, agentId, enabled, enrolled, migrations };
  }

  private context(scope: string, requireSync: boolean): Context {
    const status = this.syncStatus();
    const key = this.key();
    if (scope !== status.scope) throw conflict('The organization, agent or enrollment changed. Refresh before continuing the migration.');
    if (!status.enrolled || key?.enrollment?.organization !== status.owner || key.enrollment.server !== status.agentId) throw conflict('Enroll this agent with the current organization before migrating connectors.');
    if (requireSync && !status.enabled) throw conflict('Enable organization connector sync on the Server page before preparing or switching a connector.');
    return { key, owner: key.enrollment.organization, agentId: key.enrollment.server, scope };
  }

  private check(context: Context, record?: MigrationRecord): void {
    const current = this.context(context.scope, false);
    if (current.key.keyId !== context.key.keyId || current.owner !== context.owner || current.agentId !== context.agentId) throw conflict('The migration identity changed. Refresh before continuing.');
    if (record !== undefined && (record.owner !== current.owner || record.agentId !== current.agentId || record.keyId !== current.key.keyId)) throw conflict('This migration belongs to a different enrollment. Restore its original enrollment before reconciling it.');
  }

  private save(context: Context, record: MigrationRecord): MigrationRecord {
    this.check(context, record);
    saveMigration(record, this.dir);
    this.changed();
    return record;
  }

  private source(record: MigrationRecord): ReturnType<typeof migrationPayload> {
    const payload = migrationPayload(migrationSource(record.sourceId, this.dir, record.move === true && record.captured === true), record.oauthResource, record.move === true && record.captured === true);
    if (payload.sourceStamp !== record.sourceStamp) throw conflict('The retained local connector changed. Restore its original settings before continuing; Metro will not overwrite it.');
    return payload;
  }

  private async call(context: Context, record: MigrationRecord, action: 'begin' | 'prepare' | 'handover' | 'status' | 'activate' | 'rollback', sealed?: ReturnType<typeof sealConnectorMigration>): Promise<MigrationResponse> {
    this.check(context, record);
    let response: MigrationResponse;
    try {
      response = migrationResponseOf(await agentCall(this.api, context.key, '/api/agents/connector-migrations', {
        action, operationId: record.id, sourceId: record.sourceId, ...(sealed === undefined ? {} : { sealed }),
      }, { timeoutMs: 60_000 }));
    } catch (error) {
      throw callFailure(error, action);
    }
    this.check(context, record);
    checkResponse(record, response.migration);
    return response;
  }

  private accept(context: Context, record: MigrationRecord, remote: RemoteMigration): MigrationRecord {
    if (remote.phase !== 'preparing' && remote.phase !== 'rolled_back' && (remote.name !== record.name || remote.auth !== record.auth || remote.policy === null || !samePolicy(record.policy, remote.policy))) {
      return this.save(context, { ...record, destinationId: remote.destinationId, reason: 'destination_changed' });
    }
    return this.save(context, { ...record, destinationId: remote.destinationId, grantImported: remote.grantImported === true, reason: reasons[remote.readiness] });
  }

  private create(context: Context, id: string, oauthResource?: string, move = false): MigrationRecord {
    const payload = migrationPayload(migrationSource(id, this.dir), oauthResource);
    return this.save(context, {
      id: newId(), owner: context.owner, agentId: context.agentId, keyId: context.key.keyId,
      sourceId: id, name: payload.name, destinationId: null, phase: move ? 'freezing' : 'preparing', move, auth: payload.auth.kind,
      sourceStamp: payload.sourceStamp, policy: payload.policy, reason: null,
      ...(payload.oauthResource === undefined ? {} : { oauthResource: payload.oauthResource }),
    });
  }

  private async prepare(context: Context, record: MigrationRecord): Promise<void> {
    const payload = this.source(record);
    const begun = await this.call(context, record, 'begin');
    record = this.accept(context, record, begun.migration);
    if (begun.migration.phase === 'prepared' && !upgrading(record, begun.migration)) {
      this.save(context, { ...record, phase: 'prepared' });
      return;
    }
    if (!['preparing', 'prepared'].includes(begun.migration.phase) || begun.receiving === undefined) throw uncertain();
    const receiving = begun.receiving;
    const expected = { owner: context.owner, agent: context.agentId, keyId: context.key.keyId, operationId: record.id, sourceId: record.sourceId, destinationId: record.destinationId };
    for (const [key, value] of Object.entries(expected)) if (receiving.context[key as keyof typeof receiving.context] !== value) throw uncertain();
    const sealed = sealConnectorMigration(receiving.publicKey, receiving.context, payload);
    const { migration } = await this.call(context, record, grantTransfer(record) ? 'handover' : 'prepare', sealed);
    record = this.accept(context, record, migration);
    if (migration.phase !== 'prepared') throw uncertain();
    this.save(context, { ...record, phase: 'prepared' });
  }

  private async freeze(context: Context, record: MigrationRecord): Promise<MigrationRecord | null> {
    const until = Date.now() + 10_000;
    while (!this.localIdle(record.sourceId) && migrationUncertaintyReceipt(record.sourceId, this.dir) === null && Date.now() < until) {
      await new Promise((resolve) => { setTimeout(resolve, 100); });
      this.check(context, record);
    }
    if (this.waiting(context, record)) return null;
    flushMigrationSource(this.dir);
    const payload = migrationPayload(migrationSource(record.sourceId, this.dir, true), record.oauthResource, true);
    return this.save(context, { ...record, sourceStamp: payload.sourceStamp, captured: true, phase: 'preparing', reason: null });
  }

  private async move(context: Context, record: MigrationRecord): Promise<void> {
    if (record.phase === 'recovering') return this.finishRecovery(context, record);
    if (['active', 'rolled_back'].includes(record.phase)) return this.reconcile(context, record);
    if (record.phase === 'rollback') return this.rollback(context, record);
    if (record.phase === 'freezing') {
      const captured = await this.freeze(context, record);
      if (captured === null) return;
      record = captured;
    }
    if (record.phase === 'preparing') {
      await this.prepare(context, record);
      record = migrationRecord(record.sourceId, this.dir) ?? record;
    }
    if (record.phase === 'prepared' || record.phase === 'cutover') await this.cutover(context, record);
  }

  private waiting(context: Context, record: MigrationRecord, includeOrganization = false): boolean {
    const uncertain = migrationUncertaintyReceipt(record.sourceId, this.dir) !== null;
    if (!uncertain && this.localIdle(record.sourceId) && (!includeOrganization || this.orgIdle(record.sourceId))) return false;
    this.save(context, { ...record, reason: uncertain ? migrationRefreshUncertain(record.sourceId, this.dir) ? 'local_refresh_uncertain' : 'requests_uncertain' : 'waiting_for_local' });
    return true;
  }

  private async cutover(context: Context, record: MigrationRecord): Promise<void> {
    this.context(context.scope, true);
    this.source(record);
    if (record.phase === 'prepared') {
      const { migration } = await this.call(context, record, 'status');
      record = this.accept(context, record, migration);
      if (migration.phase !== 'prepared' || record.reason !== null) return;
      record = this.save(context, { ...record, phase: 'cutover' });
    }
    if (this.waiting(context, record)) return;
    const { migration } = await this.call(context, record, 'activate');
    record = this.accept(context, record, migration);
    if (migration.phase !== 'active' || record.reason !== null) return;
    const snapshot = await (this.deps.fresh ?? freshOrgConnectors)().catch(() => {
      throw new ApiError('Fresh organization delivery could not be verified. The source stays stopped; restore sync and reconcile this migration.', 503);
    });
    this.check(context, record);
    this.context(context.scope, true);
    if (!received(record, snapshot)) {
      this.save(context, { ...record, reason: 'sync_unavailable' });
      return;
    }
    this.save(context, { ...record, phase: 'active', reason: null });
  }

  private async rollback(context: Context, record: MigrationRecord): Promise<void> {
    if (record.phase === 'recovering') return this.finishRecovery(context, record);
    if (record.grantImported === true) throw new MigrationBlocked('finish_forward', 'Central owns this OAuth grant. Finish forward or sign in centrally; the old local tokens cannot be restored.');
    const begun = await this.call(context, record, 'begin');
    if (begun.migration.grantImported === true) {
      record = this.accept(context, record, begun.migration);
      this.save(context, { ...record, phase: begun.migration.phase === 'active' ? 'cutover' : 'prepared', reason: 'finish_forward' });
      return;
    }
    if (record.phase !== 'freezing') this.source(record);
    record = this.save(context, { ...record, phase: 'rollback' });
    if (this.waiting(context, record, true)) return;
    const { migration } = await this.call(context, record, 'rollback');
    if (migration.phase !== 'rolled_back') {
      this.accept(context, record, migration);
      return;
    }
    this.check(context, record);
    this.restore(context, record);

  }

  private restore(context: Context, record: MigrationRecord): void {
    const signOut = record.auth === 'oauth' && record.move !== true;
    if (this.deps.restore !== undefined) this.deps.restore(record.sourceId, signOut);
    else localRollbackMigrationSource(record.sourceId, signOut, this.dir);
    this.save(context, { ...record, phase: 'rolled_back', reason: signOut ? 'sign_in' : null });
  }

  private async reconcile(context: Context, record: MigrationRecord): Promise<void> {
    if (record.phase === 'recovering') return this.finishRecovery(context, record);
    if (record.phase === 'rollback') return this.rollback(context, record);
    if (record.move === true && record.phase !== 'active' && record.phase !== 'rolled_back') return this.move(context, record);
    if (record.phase === 'preparing') return this.prepare(context, record);
    if (record.phase === 'cutover') return this.cutover(context, record);
    if (record.phase === 'rolled_back') return;
    const { migration } = await this.call(context, record, 'status');
    this.accept(context, record, migration);
  }

  private obtain(context: Context, sourceId: string, action: MigrationAction, oauthResource?: string): MigrationRecord | null {
    const record = migrationRecord(sourceId, this.dir);
    if (record !== null) this.check(context, record);
    if (['prepare', 'move'].includes(action) && (record === null || record.phase === 'rolled_back')) return this.create(context, sourceId, oauthResource, action === 'move');
    if (action === 'move' && record !== null && canUpgrade(record)) return this.save(context, { ...record, move: true, phase: 'freezing' });
    if (record === null && action !== 'reconcile') throw conflict('Prepare this connector before moving it.');
    return record;
  }

  private perform(context: Context, record: MigrationRecord, action: MigrationAction): Promise<void> {
    if (action === 'move') return this.move(context, record);
    if (action === 'prepare' && record.phase === 'preparing') return this.prepare(context, record);
    if (action === 'cutover' && (record.phase === 'prepared' || record.phase === 'cutover')) return this.cutover(context, record);
    if (action === 'rollback' && record.phase !== 'rolled_back') return this.rollback(context, record);
    return this.reconcile(context, record);
  }

  private async resolve(context: Context, record: MigrationRecord, receipt: string | null): Promise<void> {
    this.check(context, record);
    if (receipt === null || receipt !== migrationUncertaintyReceipt(record.sourceId, this.dir)) throw conflict('The outstanding request receipt changed. Refresh before confirming that vendor requests have settled.');
    if (migrationRefreshUncertain(record.sourceId, this.dir)) return this.recoverRefresh(context, record, receipt);
    if (!resolveMigrationUncertainty(record.sourceId, receipt, this.dir)) throw conflict('Requests are still running or their receipt changed. Wait for vendor completion, then refresh before confirming settlement.');
    this.save(context, { ...record, reason: record.phase === 'prepared' ? 'not_verified' : null });
  }

  private async recoverRefresh(context: Context, record: MigrationRecord, receipt: string): Promise<void> {
    if (record.move !== true || !['freezing', 'rollback'].includes(record.phase) || !migrationOperationsIdle(record.sourceId, this.dir, false)) throw conflict('The uncertain local refresh must stop before aborting the handover.');
    const { migration } = await this.call(context, record, 'rollback');
    if (migration.phase !== 'rolled_back') throw uncertain();
    record = this.save(context, { ...record, phase: 'recovering', recoveryReceipt: receipt });
    await this.finishRecovery(context, record);
  }

  private async finishRecovery(context: Context, record: MigrationRecord): Promise<void> {
    const { migration } = await this.call(context, record, 'rollback');
    if (migration.phase !== 'rolled_back' || record.recoveryReceipt === undefined) throw uncertain();
    localRollbackMigrationSource(record.sourceId, true, this.dir, true);
    const receipt = migrationUncertaintyReceipt(record.sourceId, this.dir);
    if (receipt !== null && !resolveMigrationUncertainty(record.sourceId, record.recoveryReceipt, this.dir)) throw uncertain();
    this.save(context, { ...record, phase: 'rolled_back', recoveryReceipt: undefined, reason: 'sign_in' });
  }

  private validateResource(sourceId: string, action: MigrationAction, oauthResource: string | undefined): void {
    if (oauthResource === undefined) return;
    const resource = publicOAuthResource(oauthResource);
    const record = migrationRecord(sourceId, this.dir);
    if (action === 'prepare' && (record === null || record.phase === 'rolled_back')) return;
    if (record?.oauthResource !== resource) throw conflict('The public OAuth resource is fixed for this preparation. Roll back, then prepare again to change it.');
  }

  private validateIntent(sourceId: string, action: MigrationAction, operationId: string | null, receipt: string | null): void {
    if ((migrationRecord(sourceId, this.dir)?.id ?? null) !== operationId) throw conflict('This connector migration changed. Refresh before acting on its current operation.');
    if (action === 'resolve' && (receipt === null || receipt !== migrationUncertaintyReceipt(sourceId, this.dir))) throw conflict('The outstanding request receipt changed. Refresh before confirming that vendor requests have settled.');
  }

  async run(sourceId: string, action: MigrationAction, scope: string, operationId: string | null, uncertainty: string | null = null, oauthResource?: string): Promise<MigrationStatus> {
    if (this.running) throw conflict('Another migration request is still running on this agent. Refresh after it finishes.');
    const context = this.context(scope, ['move', 'prepare', 'cutover'].includes(action));
    this.validateIntent(sourceId, action, operationId, uncertainty);
    this.validateResource(sourceId, action, oauthResource);
    this.running = true;
    try {
      const record = this.obtain(context, sourceId, action, oauthResource);
      if (record !== null) {
        if (action === 'resolve') await this.resolve(context, record, uncertainty);
        else await this.perform(context, record, action);
      }
      this.check(context);
      return this.status();
    } catch (error) {
      const record = migrationRecord(sourceId, this.dir);
      if (record !== null) {
        try { this.save(context, { ...record, reason: error instanceof MigrationBlocked ? error.reason : 'unavailable' }); } catch {
          log.warn('connector migration: the interrupted operation needs reconciliation in its original enrollment');
        }
      }
      throw error;
    } finally { this.running = false; }
  }
}
