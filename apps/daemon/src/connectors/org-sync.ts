import { randomBytes } from 'node:crypto';
import { ApiError } from '@metro-labs/http/api-error';
import { AGENT_CLOCK_SKEW_MS } from '@metro-labs/http/agent-signature';
import { CONNECTOR_DELIVERY_LEASE_MS, CONNECTOR_DELIVERY_MAX_BYTES, openConnectorDelivery, type DeliveryContext, type DeliverySnapshot } from '@metro-labs/http/connector-delivery';
import type { AgentKey } from './agent-key.js';
import { agentCall, type MetroApi } from './metro-api.js';

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
  private deadline = 0;
  private wallDeadline = 0;
  private generation = 0;
  private running: Promise<void> | null = null;
  private expiry: ReturnType<typeof setTimeout> | null = null;
  private readonly monotonic: () => number;

  constructor(private readonly deps: OrgSyncDeps) {
    this.monotonic = deps.monotonic ?? (() => performance.now());
  }

  private identity(): Identity | null {
    if (!this.deps.enabled()) return null;
    const owner = this.deps.owner();
    const key = this.deps.key();
    const enrollment = key?.enrollment;
    if (owner === null || key === null || enrollment === null || enrollment === undefined || enrollment.organization !== owner) return null;
    const context = { owner, agent: enrollment.server, keyId: key.keyId };
    return { key, context, token: JSON.stringify(context) };
  }

  private forget(): void {
    this.snapshot = null;
    this.deadline = 0;
    this.wallDeadline = 0;
    if (this.expiry !== null) clearTimeout(this.expiry);
    this.expiry = null;
  }

  invalidate(): void {
    this.generation += 1;
    this.token = null;
    this.forget();
  }

  read(): DeliverySnapshot | null {
    if (this.snapshot === null) return null;
    const identity = this.identity();
    if (identity === null || identity.token !== this.token || this.monotonic() >= this.deadline || this.deps.api.now() >= this.wallDeadline) {
      this.invalidate();
      return null;
    }
    return structuredClone(this.snapshot);
  }

  async sync(refresh?: RefreshRequest): Promise<void> {
    const identity = this.identity();
    if (identity === null) {
      this.invalidate();
      return Promise.resolve();
    }
    if (identity.token !== this.token) this.invalidate();
    if (this.running !== null) return refresh === undefined ? this.running : this.running.then(() => this.sync(refresh));
    this.token = identity.token;
    this.running = this.fetch(identity, refresh).catch((err: unknown) => {
      this.invalidate();
      throw err;
    }).finally(() => { this.running = null; });
    return this.running;
  }

  private async fetch(identity: Identity, refresh: RefreshRequest | undefined): Promise<void> {
    const generation = this.generation;
    const requestId = randomBytes(32).toString('base64url');
    const context = { ...identity.context, requestId };
    const started = this.deps.api.now();
    const clock = this.monotonic();
    const response = await agentCall(this.deps.api, identity.key, '/api/agents/connectors', { requestId, ...(refresh === undefined ? {} : { refresh }) }, { answerMax: CONNECTOR_DELIVERY_MAX_BYTES, timeoutMs: 60_000 });
    if (generation !== this.generation) return;
    if (this.identity()?.token !== identity.token) {
      this.invalidate();
      return;
    }
    const snapshot = openConnectorDelivery(identity.key.sealing, context, response.sealed);
    const remaining = lease(snapshot, started, this.monotonic() - clock, this.deps.api.now());
    this.forget();
    this.snapshot = snapshot;
    this.deadline = this.monotonic() + remaining;
    this.wallDeadline = this.deps.api.now() + remaining;
    this.expiry = setTimeout(() => { this.forget(); }, remaining);
    this.expiry.unref();
  }
}
