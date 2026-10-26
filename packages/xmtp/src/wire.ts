const UID_MAP_MAX = 5000;
const uidToXmtp = new Map<string, string>();

const INBOX_ETH_CACHE_MAX = 5000;
export const inboxEthCache = new Map<string, string>();

const SENT_MAX = 5000;
const sentIds = new Set<string>();

function dropOldest(held: Map<string, string> | Set<string>, max: number): void {
  if (held.size <= max) return;
  const oldest = held.keys().next().value;
  if (oldest !== undefined) held.delete(oldest);
}

export function cacheInboxEth(inboxId: string, eth: string): void {
  inboxEthCache.set(inboxId, eth);
  dropOldest(inboxEthCache, INBOX_ETH_CACHE_MAX);
}

export function rememberUid(
  uid: string | undefined,
  xmtpId: string | undefined,
): void {
  if (!uid || !xmtpId || !uid.startsWith('msg_')) return;
  uidToXmtp.set(uid, xmtpId);
  dropOldest(uidToXmtp, UID_MAP_MAX);
}

export function resolveMsgId(rawId: string): string {
  if (!rawId.startsWith('msg_')) return rawId;
  const mapped = uidToXmtp.get(rawId);
  if (mapped) return mapped;
  throw new Error(
    `could not resolve universal id ${rawId} to an xmtp message id ` +
      '(not seen by this train; pass the raw xmtp message_id)',
  );
}

export function rememberSent(xmtpId: string | undefined): void {
  if (!xmtpId) return;
  sentIds.add(xmtpId);
  dropOldest(sentIds, SENT_MAX);
}

export const sentByMe = (xmtpId: string): boolean => sentIds.has(xmtpId);
