import { createHash, randomBytes } from 'node:crypto';
import type { ConnectorSyncStatus } from '@metro-labs/core/connector-sync';
import { errMsg, log } from '@metro-labs/core/log';
import { ApiError } from '@metro-labs/http/api-error';
import { agentsDir } from '../agents/files.js';
import { METRO_API, type MetroApi } from './metro-api.js';
import { OrgConnectorSync, type OrgSyncDeps } from './org-sync.js';
import { OrgConnectorRuntime, type RuntimeDeps } from './org-runtime.js';
import { connectorSyncScope, disableSavedSync, saveSyncSetting, syncOptedIn, syncSetting } from './org-sync-setting.js';
import type { RelaySession } from './relay-session.js';
import { publishOrgConnectors } from './publication.js';
import { orgRuntimeError, orgUnavailable } from './org-runtime-discovery.js';

type ControlDeps = Pick<OrgSyncDeps, 'owner' | 'key' | 'monotonic'> & RuntimeDeps & { api?: MetroApi; dir?: string };
type Context = Pick<ConnectorSyncStatus, 'owner' | 'agentId' | 'scope' | 'enrolled'>;
const POLL_MS = 60_000;
const emptyReceipt = { lastReceivedAt: null, leaseExpiresAt: null, counts: null };

export class OrgConnectorControl {
  private readonly dir: string;
  private readonly api: MetroApi;
  private sync: OrgConnectorSync | null = null;
  private runtime: OrgConnectorRuntime | null = null;
  private unpublished = false;
  private scope: string | null = null;
  private operation = randomBytes(16).toString('hex');
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: ControlDeps) {
    this.dir = deps.dir ?? agentsDir();
    this.api = deps.api ?? METRO_API;
  }

  private context(): Context {
    const owner = this.deps.owner();
    const key = this.deps.key();
    const enrollment = key?.enrollment;
    const agentId = owner !== null && enrollment?.organization === owner ? enrollment.server : null;
    const scope = connectorSyncScope(owner, key);
    return { owner, agentId, scope, enrolled: agentId !== null };
  }

  private clear(keepPublished = false): void {
    const runtime = this.runtime;
    if (keepPublished) runtime?.stop(true);
    this.sync?.invalidate();
    this.sync = null;
    this.runtime = null;
    try {
      runtime?.stop();
    } catch {
      log.warn('organization connectors: stopped runtime publication could not be cleared');
    }
  }

  private unpublish(): void {
    if (this.runtime !== null || this.unpublished) return;
    try {
      (this.deps.publish ?? publishOrgConnectors)([]);
      this.unpublished = true;
    } catch (err) {
      log.warn({ err: errMsg(err) }, 'organization connectors: the connector list could not be cleared');
    }
  }

  private reconcile(start: boolean): { context: Context; setting: ReturnType<typeof syncSetting> } {
    const context = this.context();
    if (this.scope !== null && this.scope !== context.scope) {
      this.clear();
      this.operation = randomBytes(16).toString('hex');
      disableSavedSync(this.dir);
    }
    this.scope = context.scope;
    const setting = syncSetting(this.dir, context.scope);
    if (setting.source === 'scope_changed') disableSavedSync(this.dir);
    if (!setting.enabled || !context.enrolled) {
      this.clear();
      this.unpublish();
    } else if (start && this.sync === null) {
      const scope = context.scope;
      this.sync = new OrgConnectorSync({ ...this.deps, api: this.api, enabled: () => this.context().scope === scope && syncSetting(this.dir, scope).enabled });
    }
    if (start) this.startRuntime();
    return { context, setting };
  }

  private startRuntime(): void {
    if (this.sync === null || this.runtime !== null) return;
    this.unpublished = false;
    this.runtime = new OrgConnectorRuntime(this.sync, this.deps);
  }

  status(): ConnectorSyncStatus {
    try {
      const { context, setting } = this.reconcile(false);
      const receipt = this.sync?.status() ?? { state: 'waiting' as const, ...emptyReceipt };
      const state = !setting.enabled ? 'off' : !context.enrolled ? 'not_enrolled' : receipt.state;
      const scope = createHash('sha256').update(`${context.scope}:${this.operation}`).digest('hex');
      return { ...context, ...setting, ...receipt, scope, state, liveEnabled: false };
    } catch {
      this.clear();
      throw new ApiError('Metro could not read the connector sync status.', 503);
    }
  }

  set(enabled: boolean, scope: string): ConnectorSyncStatus {
    const current = this.status();
    if (scope !== current.scope) throw new ApiError('The organization or enrollment changed. Refresh the sync status before trying again.', 409);
    if (enabled && !current.enrolled) throw new ApiError('Enroll this agent with its organization before enabling sync.', 409);
    saveSyncSetting(this.dir, enabled, this.context().scope);
    if (!enabled) this.clear();
    else this.tick();
    return this.status();
  }

  async poll(): Promise<void> {
    if (this.sync === null && !syncOptedIn(this.dir)) {
      this.unpublish();
      return;
    }
    try {
      this.reconcile(true);
    } catch (err) {
      this.clear();
      throw err;
    }
    await this.sync?.sync();
  }

  private tick(): void {
    this.poll().catch(() => {
      log.warn('organization connectors: memory sync unavailable; cached credentials were cleared');
    });
  }

  start(): void {
    if (this.timer !== null) return;
    this.tick();
    this.timer = setInterval(() => { this.tick(); }, POLL_MS);
    this.timer.unref();
  }

  invalidate(): void {
    this.operation = randomBytes(16).toString('hex');
    this.clear();
    disableSavedSync(this.dir);
  }

  stop(keepPublished = false): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.clear(keepPublished);
  }

  async open(id: string): Promise<RelaySession> {
    if (this.runtime === null && !syncOptedIn(this.dir)) throw new ApiError('Organization connectors are not available on this agent.', 503);
    this.reconcile(true);
    const runtime = this.runtime;
    const sync = this.sync;
    if (runtime === null || sync === null) throw new ApiError('Organization connectors are not available on this agent.', 503);
    const state = sync.status().state;
    try {
      await sync.recover();
      this.reconcile(false);
      if (this.runtime !== runtime || this.sync !== sync) throw orgUnavailable();
    } catch (error) {
      const safe = orgRuntimeError(error);
      log.debug({ stage: 'receipt_open', state, status: safe.status }, 'organization connectors: request unavailable');
      throw safe;
    }
    return runtime.open(id);
  }
}
