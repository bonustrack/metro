export { emit, respond, mintId } from '@metro-labs/mcp/stations/station-runtime';

export const SELF_URI = process.env.METRO_SELF_URI ?? '';

const UID_MAP_MAX = 5000;
const uidToXmtp = new Map<string, string>();

const INBOX_ETH_CACHE_MAX = 5000;
export const inboxEthCache = new Map<string, string>();

export function cacheInboxEth(inboxId: string, eth: string): void {
  inboxEthCache.set(inboxId, eth);
  if (inboxEthCache.size > INBOX_ETH_CACHE_MAX) {
    const oldest = inboxEthCache.keys().next().value;
    if (oldest !== undefined) inboxEthCache.delete(oldest);
  }
}

export function rememberUid(
  uid: string | undefined,
  xmtpId: string | undefined,
): void {
  if (!uid || !xmtpId || !uid.startsWith('msg_')) return;
  uidToXmtp.set(uid, xmtpId);
  if (uidToXmtp.size > UID_MAP_MAX) {
    const oldest = uidToXmtp.keys().next().value;
    if (oldest !== undefined) uidToXmtp.delete(oldest);
  }
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
