import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isWebhookSecret, webhookSignature } from '@metro-labs/http/standard-webhooks';
import { HOST, listen } from './helpers.ts';

export interface Subscription {
  id: string;
  url: string;
  secret: string;
  cursor: string | null;
  ttlMs: number | null;
}

export interface EventsServer {
  base: string;
  subscribes: Subscription[];
  unsubscribes: string[];
  methods: string[];
  verified: string[];
  state: {
    accepted: string;
    capability: 'top' | 'experimental' | 'none';
    metroBase: string;
    grantMs: number;
    cursor: string | null;
    verify: boolean;
    signedOut: boolean;
    now: () => number;
  };
  live: () => Subscription[];
  deliver: (subscription: Subscription, body: unknown, options?: { secret?: string; at?: number; id?: string }) => Promise<Response>;
  close: () => Promise<void>;
}

export const MAIL_TOOLS = [
  { name: 'read', description: 'Read a thread or search the mailbox.', annotations: { readOnlyHint: true } },
  { name: 'send', description: 'Send a new email, or reply-all on a thread.' },
  { name: 'reply', description: 'Answer one message.' },
];

export function mailEvent(eventId: string, data: Record<string, unknown> = {}, cursor: string | null = `c-${eventId}`): Record<string, unknown> {
  return {
    eventId,
    name: 'email.received',
    timestamp: '2026-11-09T09:00:00.000Z',
    data: {
      messageId: `m-${eventId}`,
      threadId: 'thread/one+1',
      from: { address: 'Lisa@Anderra.ch', name: 'Lisa Rossi' },
      to: ['agent@example.com'],
      cc: [],
      subject: 'Quarterly numbers',
      receivedAt: '2026-11-09T08:59:00.000Z',
      text: 'SECRET_MAIL_BODY please look at the numbers.',
      senderVerified: true,
      attachments: [{ name: 'q3.pdf', mime: 'application/pdf', size: 2048, url: 'https://files.example.com/q3.pdf?sig=abc' }],
      ...data,
    },
    cursor,
  };
}

async function bodyOf(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

const json = (res: ServerResponse, message: unknown): void => {
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(message));
};

const local = (server: EventsServer, url: string): string => url.replace(`https://${HOST}`, server.state.metroBase);

export async function post(server: EventsServer, subscription: Subscription, body: unknown, options: { secret?: string; at?: number; id?: string } = {}): Promise<Response> {
  const text = JSON.stringify(body);
  const id = options.id ?? (typeof (body as { eventId?: unknown }).eventId === 'string' ? String((body as { eventId: string }).eventId) : `msg_control_${randomBytes(4).toString('hex')}`);
  const timestamp = String(Math.floor((options.at ?? server.state.now()) / 1000));
  const signature = webhookSignature(options.secret ?? subscription.secret, id, timestamp, text);
  return fetch(local(server, subscription.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': signature, 'x-mcp-subscription-id': subscription.id },
    body: text,
  });
}

async function verify(server: EventsServer, subscription: Subscription): Promise<boolean> {
  const challenge = randomBytes(12).toString('hex');
  const res = await post(server, subscription, { type: 'verification', challenge });
  const answer = (await res.json().catch(() => ({}))) as { challenge?: string };
  if (res.ok && answer.challenge === challenge) server.verified.push(subscription.url);
  return res.ok && answer.challenge === challenge;
}

type Params = { name?: string; delivery?: { mode?: string; url?: string; secret?: string }; cursor?: string | null; ttlMs?: number | null };

async function subscribe(server: EventsServer, id: number, params: Params): Promise<unknown> {
  const url = params.delivery?.url ?? '';
  const secret = params.delivery?.secret ?? '';
  if (params.name !== 'email.received' || params.delivery?.mode !== 'webhook' || !url.startsWith('https://') || !isWebhookSecret(secret)) return { jsonrpc: '2.0', id, error: { code: -32602, message: 'invalid params' } };
  if (server.state.signedOut) return { jsonrpc: '2.0', id, error: { code: -32024, message: 'The mailbox is signed out.' } };
  const subscription: Subscription = { id: `sub_${createHash('sha256').update(url).digest('hex').slice(0, 24)}`, url, secret, cursor: params.cursor ?? null, ttlMs: params.ttlMs ?? null };
  const refresh = server.live().some((sub) => sub.url === url);
  server.subscribes.push(subscription);
  const allowlisted = url.startsWith(`https://${HOST}/v1/events/`) && !server.state.verify;
  if (!allowlisted && !server.verified.includes(url) && !(await verify(server, subscription))) return { jsonrpc: '2.0', id, error: { code: -32027, message: 'callback endpoint error', data: { reason: 'challenge_failed' } } };
  const refreshBefore = new Date(server.state.now() + Math.min(server.state.grantMs, params.ttlMs ?? server.state.grantMs)).toISOString();
  const status = refresh ? { deliveryStatus: { active: true, lastDeliveryAt: null, lastError: null } } : {};
  return { jsonrpc: '2.0', id, result: { id: subscription.id, refreshBefore, cursor: server.state.cursor, truncated: false, ...status } };
}

function capabilities(server: EventsServer): Record<string, unknown> {
  if (server.state.capability === 'top') return { tools: {}, events: { listChanged: true } };
  if (server.state.capability === 'experimental') return { tools: {}, experimental: { events: { listChanged: false } } };
  return { tools: {} };
}

async function rpc(server: EventsServer, message: { id?: number; method: string; params?: Params & { delivery?: { url?: string } } }, res: ServerResponse): Promise<void> {
  const id = message.id ?? 0;
  if (message.method === 'initialize') json(res, { jsonrpc: '2.0', id, result: { protocolVersion: '2025-11-25', capabilities: capabilities(server), serverInfo: { name: 'mail-mcp' } } });
  else if (message.method === 'notifications/initialized') res.writeHead(202).end();
  else if (message.method === 'tools/list') json(res, { jsonrpc: '2.0', id, result: { tools: MAIL_TOOLS } });
  else if (message.method === 'events/list') json(res, { jsonrpc: '2.0', id, result: { events: [{ name: 'email.received', description: 'A new mail in the Inbox.', delivery: ['webhook'], inputSchema: { type: 'object', properties: {}, additionalProperties: false }, payloadSchema: { type: 'object' } }, { name: 'calendar.changed', delivery: ['poll'] }] } });
  else if (message.method === 'events/subscribe') json(res, await subscribe(server, id, message.params ?? {}));
  else if (message.method === 'events/unsubscribe') {
    const url = message.params?.delivery?.url ?? '';
    const known = server.live().some((sub) => sub.url === url);
    server.unsubscribes.push(url);
    json(res, known ? { jsonrpc: '2.0', id, result: {} } : { jsonrpc: '2.0', id, error: { code: -32023, message: 'no such subscription', data: { kind: 'subscription' } } });
  } else json(res, { jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } });
}

export async function startEventsServer(): Promise<EventsServer> {
  const server: EventsServer = {
    base: '',
    subscribes: [],
    unsubscribes: [],
    methods: [],
    verified: [],
    state: { accepted: 'Bearer VENDOR_KEY', capability: 'experimental', metroBase: '', grantMs: 24 * 60 * 60_000, cursor: 'history-1', verify: false, signedOut: false, now: Date.now },
    live: () => server.subscribes.filter((sub) => !server.unsubscribes.includes(sub.url)),
    deliver: (subscription, body, options) => post(server, subscription, body, options),
    close: () => Promise.resolve(),
  };
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const text = await bodyOf(req);
    if (req.method === 'DELETE') {
      res.writeHead(204).end();
      return;
    }
    if (req.headers.authorization !== server.state.accepted) {
      res.writeHead(401).end();
      return;
    }
    const message = JSON.parse(text) as { id?: number; method: string; params?: Params };
    server.methods.push(message.method);
    await rpc(server, message, res);
  };
  const started = await listen((req, res) => {
    handle(req, res).catch(() => {
      res.writeHead(500).end();
    });
  });
  server.base = started.base;
  server.close = started.close;
  return server;
}
