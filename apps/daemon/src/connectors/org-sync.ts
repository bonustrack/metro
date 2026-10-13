import { randomBytes } from 'node:crypto';
import { log } from '@metro-labs/core/log';
import type { ConnectorSyncReceipt } from '@metro-labs/core/connector-sync';
import { ApiError } from '@metro-labs/http/api-error';
import { AGENT_CLOCK_SKEW_MS } from '@metro-labs/http/agent-signature';
import { CONNECTOR_DELIVERY_LEASE_MS, CONNECTOR_DELIVERY_MAX_BYTES, openConnectorDelivery, type DeliveryContext, type DeliverySnapshot } from '@metro-labs/http/connector-delivery';
import type { AgentKey } from './agent-key.js';
import { agentCall, MetroApiRefusal, type MetroApi } from './metro-api.js';

interface Identity {
  key: AgentKey;
  context: Omit<DeliveryContext, 'requestId'>;
  token: string;
}

export interface OrgSyncDeps {
  enabled: () => boolean;
  owner: () => string | null;
  key: () => AgentKey | null;
  api: MetroApi;
  monotonic?: () => number;
}

interface RefreshRequest {
  connectorId: string;
  revision: string;
}

const invalid = (): ApiError => new ApiError('Metro received an invalid or expired organization connector snapshot.', 503);

function lease(snapshot: DeliverySnapshot, started: number, elapsed: number, now: number): number {
  const duration = snapshot.expiresAt - snapshot.issuedAt;
  if (duration <= 0 || duration > CONNECTOR_DELIVERY_LEASE_MS || snapshot.issuedAt > now + AGENT_CLOCK_SKEW_MS || snapshot.issuedAt < started - AGENT_CLOCK_SKEW_MS) throw invalid();
  const expiries = snapshot.connectors.flatMap((row) => row.state === 'ready' && row.expiresAt !== undefined ? [row.expiresAt] : []);
  const remaining = Math.min(duration, ...expiries.map((at) => at - snapshot.issuedAt)) - elapsed;
  if (remaining <= 0) throw invalid();
  return remaining;
}

export class OrgConnectorSync {
  private snapshot: DeliverySnapshot | null = null;
  private token: string | null = null;
  private controller: AbortController | null = null;
  private receiptToken: string | null = null;
  private receipt: ConnectorSyncReceipt = { state: 'waiting', lastReceivedAt: null, leaseExpiresAt: null, counts: null };
  private deadline = 0;
  private wallDeadline = 0;
  private generation = 0;
  private running: Promise<void> | null = null;
  private recovery: Promise<void> | null = null;
  private expiry: ReturnType<typeof setTimeout> | null = null;
  private readonly monotonic: () => number;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly deps: OrgSyncDeps) {
    this.monotonic = deps.monotonic ?? (() => performance.now());
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  epoch(): number {
    return this.generation;
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        log.warn('organization connectors: a memory change listener failed');
      }
    }
  }

  private identity(): Identity | null {
    if (!this.deps.enabled()) return null;
    const owner = this.deps.owner();
    const key = this.deps.key();
    const enrollment = key?.enrollment;
    if (owner === null || key === null || enrollment === null || enrollment === undefined || enrollment.organization !== owner) return null;
    const context = { owner, agent: enrollment.server, keyId: key.keyId };
    return { key, context, token: JSON.stringify([context, key.sealingKey]) };
  }

  private forget(): void {
    this.snapshot = null;
    this.deadline = 0;
    this.wallDeadline = 0;
    if (this.expiry !== null) clearTimeout(this.expiry);
    this.expiry = null;
  }

  private refused = false;
  private settled = false;

  lapsed(): boolean {
    return !this.refused && (!this.settled || this.receipt.state === 'expired' || this.receipt.state === 'unavailable');
  }

  invalidate(reason: 'waiting' | 'expired' | 'unavailable' = 'waiting'): void {
    if (reason === 'waiting') this.settled = true;
    this.generation += 1;
    this.controller?.abort();
    this.controller = null;
    if (reason === 'waiting') {
      this.receiptToken = null;
      this.receipt = { state: reason, lastReceivedAt: null, leaseExpiresAt: null, counts: null };
    } else this.receipt = { ...this.receipt, state: reason, counts: null };
    this.token = null;
    this.forget();
    this.notify();
  }

  private validate(identity: Identity | null): void {
    if (this.token === null) return;
    if (identity === null || identity.token !== this.token) this.invalidate();
    else if (this.snapshot !== null && (this.monotonic() >= this.deadline || this.deps.api.now() >= this.wallDeadline)) this.invalidate('expired');
  }

  read(): DeliverySnapshot | null {
    if (this.token === null) return null;
    try {
      this.validate(this.identity());
    } catch {
      this.invalidate();
      log.warn('organization connectors: memory could not be checked and was cleared');
    }
    return this.snapshot === null ? null : structuredClone(this.snapshot);
  }

  status(): ConnectorSyncReceipt {
    this.read();
    try {
      if (this.receiptToken !== null && this.identity()?.token !== this.receiptToken) this.invalidate();
    } catch {
      this.invalidate();
    }
    return structuredClone(this.receipt);
  }

  async sync(refresh?: RefreshRequest): Promise<void> {
    let identity: Identity | null;
    try {
      identity = this.identity();
      this.validate(identity);
    } catch (err) {
      this.invalidate();
      throw err;
    }
    if (identity === null) return;
    if (this.running !== null) return refresh === undefined ? this.running : this.running.then(() => this.sync(refresh));
    this.token = identity.token;
    const generation = this.generation;
    this.controller = new AbortController();
    this.running = this.fetch(identity, refresh, generation, this.controller.signal).then(() => {
      this.refused = false;
    }, (err: unknown) => {
      if (generation === this.generation) {
        this.refused = err instanceof MetroApiRefusal && err.upstreamStatus < 500;
        this.invalidate('unavailable');
      }
      throw err;
    }).finally(() => { this.running = null; });
    return this.running;
  }

  recover(): Promise<void> {
    if (this.read() !== null) return Promise.resolve();
    this.recovery ??= this.syncFresh().finally(() => { this.recovery = null; });
    return this.recovery;
  }

  async syncFresh(refresh?: RefreshRequest): Promise<void> {
    if (this.running !== null) {
      await this.running.catch(() => {
        log.debug('organization connectors: a previous sync failed before a fresh check');
      });
    }
    return this.sync(refresh);
  }

  private async fetch(identity: Identity, refresh: RefreshRequest | undefined, generation: number, signal: AbortSignal): Promise<void> {
    const requestId = randomBytes(32).toString('base64url');
    const context = { ...identity.context, requestId };
    const started = this.deps.api.now();
    const clock = this.monotonic();
    const response = await agentCall(this.deps.api, identity.key, '/api/agents/connectors?policy_layers=1', { requestId, ...(refresh === undefined ? {} : { refresh }) }, { answerMax: CONNECTOR_DELIVERY_MAX_BYTES, timeoutMs: 60_000, signal });
    this.validate(this.identity());
    if (generation !== this.generation || this.token !== identity.token) throw invalid();
    const snapshot = openConnectorDelivery(identity.key.sealing, context, response.sealed);
    const remaining = lease(snapshot, started, this.monotonic() - clock, this.deps.api.now());
    this.forget();
    this.snapshot = snapshot;
    this.deadline = this.monotonic() + remaining;
    this.wallDeadline = this.deps.api.now() + remaining;
    this.receiptToken = identity.token;
    const total = snapshot.connectors.length;
    const ready = snapshot.connectors.filter((row) => row.state === 'ready').length;
    this.settled = true;
    this.receipt = { state: 'received', lastReceivedAt: this.deps.api.now(), leaseExpiresAt: this.wallDeadline, counts: { total, ready, unavailable: total - ready } };
    this.expiry = setTimeout(() => { this.invalidate('expired'); }, remaining);
    this.expiry.unref();
    this.notify();
  }
}
