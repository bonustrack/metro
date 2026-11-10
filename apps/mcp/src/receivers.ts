import type { SubscriptionRow, SubscriptionStore } from '@metro-labs/connectors/db/connector-subscriptions';
import { openSecret, sealSecret } from '@metro-labs/connectors/secrets';

const HELD_MS = 30_000;
const HELD_MAX = 5_000;
const BURST = 30;
const PER_SECOND = 10;

export interface HeldReceiver {
  row: SubscriptionRow;
  secret: string;
}

interface Held extends HeldReceiver {
  at: number;
}

export function webhookSecretOf(key: Buffer, row: Pick<SubscriptionRow, 'owner' | 'id' | 'secret'>): string {
  const value = openSecret(key, row.owner, row.id, row.secret, 'webhook');
  if (typeof value !== 'string') throw new Error('The webhook secret could not be read.');
  return value;
}

export const sealWebhookSecret = (key: Buffer, row: Pick<SubscriptionRow, 'owner' | 'id'>, secret: string): string => sealSecret(key, row.owner, row.id, secret, 'webhook');

export class Receivers {
  private readonly held = new Map<string, Held>();
  private known = new Set<string>();
  private tokens = BURST;
  private filledAt: number;

  constructor(
    private readonly key: Buffer,
    private readonly store: Pick<SubscriptionStore, 'find'>,
    private readonly now: () => number,
  ) {
    this.filledAt = now();
  }

  note(ids: string[]): void {
    this.known = new Set(ids);
    for (const id of this.held.keys()) if (!this.known.has(id)) this.held.delete(id);
  }

  forget(id: string): void {
    this.held.delete(id);
  }

  async find(id: string): Promise<HeldReceiver | null | 'busy'> {
    const held = this.held.get(id);
    if (held !== undefined && this.now() - held.at < HELD_MS) return held;
    if (!this.known.has(id) && !this.spend()) return 'busy';
    return this.load(id);
  }

  async reload(id: string, stale: HeldReceiver): Promise<HeldReceiver | null> {
    if (!this.spend()) return null;
    const fresh = await this.load(id);
    return fresh === null || (fresh.row.secret === stale.row.secret && fresh.row.serverId === stale.row.serverId) ? null : fresh;
  }

  private async load(id: string): Promise<HeldReceiver | null> {
    const row = await this.store.find(id);
    if (row === null) {
      this.held.delete(id);
      this.known.delete(id);
      return null;
    }
    const held = { row, secret: webhookSecretOf(this.key, row), at: this.now() };
    this.held.delete(id);
    this.held.set(id, held);
    this.known.add(id);
    for (const oldest of this.held.keys()) {
      if (this.held.size <= HELD_MAX) break;
      this.held.delete(oldest);
    }
    return held;
  }

  private spend(): boolean {
    const now = this.now();
    this.tokens = Math.min(BURST, this.tokens + (Math.max(0, now - this.filledAt) / 1000) * PER_SECOND);
    this.filledAt = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
