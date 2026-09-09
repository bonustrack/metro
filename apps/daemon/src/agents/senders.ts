import { bufferedSince, type MetroEvent } from '@metro-labs/core/events';
import { accountFromLine } from './map.js';

export interface RecentSender {
  id: string;
  name: string;
  at: string;
}

const DEFAULT_LIMIT = 20;

const SKIP = new Set(['', 'self', 'unknown']);

function sameAccount(from: string, station: string, accountId: string): boolean {
  const account = accountFromLine(from);
  return account?.station === station && account.accountId === accountId;
}

function senderOf(event: MetroEvent, station: string, accountId: string): { id: string; name: string } | null {
  const from = String(event.from);
  if (event.station !== station || !sameAccount(from, station, accountId)) return null;
  const id = from.split('/').pop() ?? '';
  if (SKIP.has(id)) return null;
  return { id, name: event.fromDisplayName ?? event.fromName ?? '' };
}

export function recentSenders(station: string, accountId: string, limit = DEFAULT_LIMIT): RecentSender[] {
  const seen = new Set<string>();
  const out: RecentSender[] = [];
  for (const { event } of bufferedSince(0).reverse()) {
    const sender = senderOf(event, station, accountId);
    if (sender === null || seen.has(sender.id.toLowerCase())) continue;
    seen.add(sender.id.toLowerCase());
    out.push({ ...sender, at: event.ts });
    if (out.length >= limit) break;
  }
  return out;
}
