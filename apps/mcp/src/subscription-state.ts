import type { ConnectorRow } from '@metro-labs/connectors/db/connectors';
import type { SubscriptionChange, SubscriptionRow } from '@metro-labs/connectors/db/connector-subscriptions';
import { detailOf } from '@metro-labs/connectors/model';

export const SUBSCRIPTION_TTL_MS = 24 * 60 * 60_000;
export const RETRY_MS = 60_000;
export const RETRY_MAX_MS = 60 * 60_000;
export const SIGNED_OUT_RETRY_MS = 24 * 60 * 60_000;
const MIN_REFRESH_MS = 60_000;

export const SIGNED_OUT = 'This connector is signed out. Sign in to it again to receive events.';
export const ACCESS_LOST = 'This connector says its access was lost. Sign in to it again to receive events.';
export const accessRefused = (name: string): string => `This connector does not let its sign-in receive ${name}. Sign in to it again with an account that may.`;

export function signInMark(connector: Pick<ConnectorRow, 'authGeneration' | 'detail'>): string {
  const detail = detailOf(connector.detail);
  return [connector.authGeneration ?? '', detail.signedInAt ?? '', detail.verifiedAt ?? ''].join(' ');
}

export const retryAfter = (failures: number): number => Math.min(RETRY_MS * 2 ** Math.min(Math.max(failures - 1, 0), 10), RETRY_MAX_MS);

export function refreshAt(now: number, refreshBefore: number | null): number {
  const lifetime = refreshBefore === null ? SUBSCRIPTION_TTL_MS : refreshBefore - now;
  return now + Math.max(MIN_REFRESH_MS, Math.floor(lifetime / 2));
}

export function endedChange(sub: Pick<SubscriptionRow, 'failures'>, now: number, state: { status: 'signed_out' | 'pending' | 'error'; error: string | null }): SubscriptionChange {
  const next = state.status === 'signed_out' ? now + SIGNED_OUT_RETRY_MS : now + retryAfter(sub.failures + 1);
  return { ...state, serverId: null, refreshBefore: null, subscribedAt: null, failures: sub.failures + 1, nextAt: next };
}
