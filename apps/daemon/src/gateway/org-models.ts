import { errMsg, log } from '@metro-labs/core/log';
import type { AgentKey } from '../connectors/agent-key.js';
import { agentCall, MetroApiRefusal, type MetroApi } from '../connectors/metro-api.js';
import { deliveredOf, refreshedConnection, type Delivered } from './delivered.js';
import type { Connection } from '@metro-labs/inference/model-config';

const MODELS_PATH = '/api/agents/models';
const REFRESH_PATH = '/api/agents/models/refresh';
const SYNC_MS = 60_000;
const PAGE_SYNC_MS = 5_000;
const AGENT_KEY_MISSING = 'agent_key_missing';

export interface OrgModelsDeps {
  owner: () => string | null;
  key: () => AgentKey | null;
  api: MetroApi;
  pageSyncMs?: number;
}

export interface SyncStatus {
  enrolled: boolean;
  at: string | null;
  error: string | null;
}

const identityRefused = (err: unknown): boolean => err instanceof MetroApiRefusal && err.upstreamStatus === 401 && err.code === AGENT_KEY_MISSING;

export class OrgModels {
  private kept: Delivered | null = null;
  private status: SyncStatus = { enrolled: false, at: null, error: null };
  private running: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private trailing: ReturnType<typeof setTimeout> | null = null;
  private pageAt = Number.NEGATIVE_INFINITY;
  private readonly refreshing = new Map<string, Promise<Connection | null>>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly deps: OrgModelsDeps) {}

  current(): Delivered | null {
    return this.kept;
  }

  syncStatus(): SyncStatus {
    return { ...this.status };
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  sync(): Promise<void> {
    this.running ??= this.run().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  requested(): Promise<void> {
    const now = this.deps.api.now();
    const wait = this.pageAt + (this.deps.pageSyncMs ?? PAGE_SYNC_MS) - now;
    if (wait <= 0) {
      this.pageAt = now;
      return this.sync();
    }
    this.trailing ??= this.later(wait);
    return this.running ?? Promise.resolve();
  }

  start(everyMs = SYNC_MS): void {
    if (this.timer !== null) return;
    const tick = (): void => {
      this.sync().catch((err: unknown) => {
        log.warn({ err: errMsg(err) }, 'org-models: the model setup could not be read');
      });
    };
    tick();
    this.timer = setInterval(tick, everyMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    if (this.trailing !== null) clearTimeout(this.trailing);
    this.timer = null;
    this.trailing = null;
  }

  refresh(conn: Connection): Promise<Connection | null> {
    const newer = this.kept?.connections.find((c) => c.id === conn.id && c.revision > conn.revision);
    if (newer !== undefined) return Promise.resolve(newer);
    const slot = `${conn.id}\n${String(conn.revision)}`;
    const found = this.refreshing.get(slot);
    if (found !== undefined) return found;
    const run = this.askRefresh(conn).finally(() => {
      this.refreshing.delete(slot);
    });
    this.refreshing.set(slot, run);
    return run;
  }

  private later(wait: number): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      this.trailing = null;
      this.requested().catch((err: unknown) => {
        log.warn({ err: errMsg(err) }, 'org-models: the model setup could not be read');
      });
    }, wait);
    timer.unref();
    return timer;
  }

  private enrolledKey(): AgentKey | null {
    try {
      const key = this.deps.key();
      const owner = this.deps.owner();
      return key !== null && owner !== null && key.enrollment?.organization === owner ? key : null;
    } catch (err) {
      log.warn({ err: errMsg(err) }, 'org-models: the agent key could not be read');
      return null;
    }
  }

  private keep(next: Delivered | null): void {
    const changed = JSON.stringify(next) !== JSON.stringify(this.kept);
    this.kept = next;
    if (changed) this.notify();
  }

  private notify(): void {
    for (const listener of [...this.listeners])
      try {
        listener();
      } catch (err) {
        log.warn({ err: errMsg(err) }, 'org-models: a model change listener failed');
      }
  }

  private failed(error: string, clear: boolean): void {
    if (this.status.error !== error) log.warn({ err: error, kept: !clear && this.kept !== null }, clear ? 'org-models: api.metro.box no longer knows this agent key, so the model setup is cleared' : 'org-models: api.metro.box did not deliver the model setup, so the last one stands');
    this.status = { ...this.status, error };
    if (clear) this.keep(null);
  }

  private async run(): Promise<void> {
    const key = this.enrolledKey();
    if (key === null) {
      this.status = { enrolled: false, at: null, error: null };
      this.keep(null);
      return;
    }
    this.status = { ...this.status, enrolled: true };
    try {
      const delivered = deliveredOf(await agentCall(this.deps.api, key, MODELS_PATH, {}));
      if (delivered === null) {
        this.failed('api.metro.box sent a model setup Metro cannot read', false);
        return;
      }
      if (this.status.error !== null) log.info('org-models: the model setup is read from api.metro.box again');
      this.status = { enrolled: true, at: new Date(this.deps.api.now()).toISOString(), error: null };
      this.keep(delivered);
    } catch (err) {
      this.failed(errMsg(err), identityRefused(err));
    }
  }

  private async askRefresh(conn: Connection): Promise<Connection | null> {
    const key = this.enrolledKey();
    if (key === null) return null;
    try {
      const fresh = refreshedConnection(await agentCall(this.deps.api, key, REFRESH_PATH, { connection: conn.id, revision: conn.revision }));
      if (fresh?.id !== conn.id) throw new Error('api.metro.box answered the refresh with another connection');
      const kept = this.kept;
      if (kept !== null) this.keep({ ...kept, connections: kept.connections.map((c) => (c.id === fresh.id ? fresh : c)) });
      log.info({ connection: conn.id, revision: fresh.revision }, 'org-models: api.metro.box renewed the sign-in of a connection');
      return fresh;
    } catch (err) {
      log.warn({ connection: conn.id, err: errMsg(err) }, 'org-models: api.metro.box could not renew the sign-in of a connection');
      return null;
    }
  }
}

let shared: OrgModels | null = null;

export const orgModels = (): OrgModels | null => shared;

export const deliveredSetup = (): Delivered | null => shared?.current() ?? null;

export function startOrgModels(deps: OrgModelsDeps, everyMs = SYNC_MS): OrgModels {
  shared?.stop();
  shared = new OrgModels(deps);
  shared.start(everyMs);
  log.info('org-models: the model setup comes from the organization on api.metro.box once the agent is enrolled');
  return shared;
}

export function stopOrgModels(): void {
  shared?.stop();
}
