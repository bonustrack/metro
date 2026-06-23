import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { Line, asLine } from '@metro-labs/mcp/lines';
import { mintId, type MetroEvent } from '@metro-labs/mcp/events';
import type { Endpoint } from '@metro-labs/mcp/endpoints';
import type { Station, Verb } from '@metro-labs/mcp/stations/types';

const sessionOwner = (sessionId: string): Line =>
  asLine(`metro://session/${sessionId}`);

export const webhookStation: Station = {
  name: 'webhook',
  hasAccounts: false,
  messageVerbs: new Set<Verb>(),
  attachmentMode: 'none',
  parseLine: (line) => {
    const p = Line.parse(line);
    return p?.station === 'webhook' && p.path.length
      ? { accountId: 'default', resource: p.path.join('/') }
      : null;
  },
  mutates: new Set<string>(),
  tools: [],
};

export function webhookEntry(
  endpoint: Endpoint,
  headers: Record<string, string>,
  body: unknown,
  method: string,
  url: string,
): MetroEvent {
  const line = Line.webhook(endpoint.id);
  return {
    id: mintId(),
    ts: new Date().toISOString(),
    station: 'webhook',
    line,
    lineName: endpoint.label,
    from: line,
    to: endpoint.session ? sessionOwner(endpoint.session) : line,
    messageId:
      headers['x-github-delivery'] || headers['x-request-id'] || randomUUID(),
    text: `${headers['x-github-event'] ?? headers['x-intercom-topic'] ?? 'event'} ${method} ${url}`,
    payload: { headers, body },
  };
}

export function verifyWebhookSig(
  secret: string,
  raw: Buffer,
  header?: string,
): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const given = Buffer.from(header.slice(7), 'hex');
  const want = createHmac('sha256', secret).update(raw).digest();
  return given.length === want.length && timingSafeEqual(given, want);
}
