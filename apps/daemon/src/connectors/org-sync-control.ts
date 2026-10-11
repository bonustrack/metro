import { createHash, randomBytes } from 'node:crypto';
import type { ConnectorSyncStatus } from '@metro-labs/core/connector-sync';
import { log } from '@metro-labs/core/log';
import { ApiError } from '@metro-labs/http/api-error';
import { agentsDir } from '../agents/files.js';
import { METRO_API, type MetroApi } from './metro-api.js';
import { OrgConnectorSync, type OrgSyncDeps } from './org-sync.js';
import { OrgConnectorRuntime } from './org-runtime.js';
import { connectorSyncScope, disableSavedSync, saveSyncSetting, syncOptedIn, syncSetting } from './org-sync-setting.js';
import type { RelaySession } from './relay-session.js';

type ControlDeps = Pick<OrgSyncDeps, 'owner' | 'key' | 'monotonic'> & { api?: MetroApi; dir?: string };
type Context = Pick<ConnectorSyncStatus, 'owner' | 'agentId' | 'scope' | 'enrolled'>;
const POLL_MS = 60_000;
const liveEnabled = (): boolean => process.env.METRO_CONNECTORS_LIVE_ENABLED === 'true';
const emptyReceipt = { lastReceivedAt: null, leaseExpiresAt: null, counts: null };

export class OrgConnectorControl {
  private readonly dir: string;
  private readonly api: MetroApi;
  private sync: OrgConnectorSync | null = null;
  private runtime: OrgConnectorRuntime | null = null;
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

  private clear(): void {
    this.sync?.invalidate();
    this.sync = null;
    const runtime = this.runtime;
    this.runtime = null;
    try {
      runtime?.stop();
    } catch {
      log.warn('organization connectors: stopped runtime publication could not be cleared');
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
    if (!setting.enabled || !context.enrolled) this.clear();
    else if (start && this.sync === null) {
      const scope = context.scope;
      this.sync = new OrgConnectorSync({ ...this.deps, api: this.api, enabled: () => this.context().scope === scope && syncSetting(this.dir, scope).enabled });
      if (liveEnabled()) this.runtime = new OrgConnectorRuntime(this.sync, { enabled: liveEnabled });
    }
    return { context, setting };
  }

  status(): ConnectorSyncStatus {
    try {
      const { context, setting } = this.reconcile(false);
      const receipt = this.sync?.status() ?? { state: 'waiting' as const, ...emptyReceipt };
      const state = !setting.enabled ? 'off' : !context.enrolled ? 'not_enrolled' : receipt.state;
      const scope = createHash('sha256').update(`${context.scope}:${this.operation}`).digest('hex');
      return { ...context, ...setting, ...receipt, scope, state, liveEnabled: liveEnabled() };
    } catch {
      this.clear();
      throw new ApiError('Metro could not read the connector sync status.', 503);
    }
  }

  set(enabled: boolean, scope: string): ConnectorSyncStatus {
    const current = this.status();
    if (scope !== current.scope) throw new ApiError('The organization or enrollment changed. Refresh the sync status before trying again.', 409);
    if (enabled && !current.enrolled) throw new ApiError('Enroll this agent with its organization before enabling sync.', 409);
    if (enabled && liveEnabled()) throw new ApiError('Live organization tools are enabled separately on this server. Disable that setting before enabling memory-only sync here.', 409);
    saveSyncSetting(this.dir, enabled, this.context().scope);
    if (!enabled) this.clear();
    else this.tick();
    return this.status();
  }

  async poll(): Promise<void> {
    if (this.sync === null && !syncOptedIn(this.dir)) return;
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

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.clear();
  }

  open(id: string): RelaySession {
    if (this.runtime === null) throw new ApiError('Organization connectors are not available on this agent.', 503);
    this.reconcile(false);
    if (!liveEnabled() || this.runtime === null) throw new ApiError('Organization connectors are not available on this agent.', 503);
    return this.runtime.open(id);
  }
}
