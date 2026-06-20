/** Webhook receive logic — the station-specific half of the HTTP receiver. The
 *  generic transport (the `/wh/<id>` route, body read, response) stays in the
 *  dispatcher; this owns how a hit becomes a HistoryEntry and how it's verified. */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { Line } from '../../lines.js';
import { mintId, type HistoryEntry } from '../../history.js';
import { sessionOwner } from '../../sessions.js';
import type { Endpoint } from '../../tunnel.js';

/** Build the HistoryEntry minted for an inbound webhook hit. Pure so the
 *  session-attribution rule is unit-testable. `to` is the endpoint's bound
 *  session owner when `endpoint.session` is set, else the webhook line itself. */
export function webhookEntry(
  endpoint: Endpoint, headers: Record<string, string>, body: unknown, method: string, url: string,
): HistoryEntry {
  const line = Line.webhook(endpoint.id);
  return {
    id: mintId(), ts: new Date().toISOString(), station: 'webhook',
    line, lineName: endpoint.label, from: line,
    to: endpoint.session ? sessionOwner(endpoint.session) : line,
    messageId: headers['x-github-delivery'] || headers['x-request-id'] || randomUUID(),
    text: `${headers['x-github-event'] ?? headers['x-intercom-topic'] ?? 'event'} ${method} ${url}`,
    payload: { headers, body },
  };
}

/** Verify a GitHub-style `sha256=<hex>` HMAC signature over the raw body. */
export function verifyWebhookSig(secret: string, raw: Buffer, header?: string): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const given = Buffer.from(header.slice(7), 'hex');
  const want = createHmac('sha256', secret).update(raw).digest();
  return given.length === want.length && timingSafeEqual(given, want);
}
