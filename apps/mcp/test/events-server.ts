import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { EVENT_ERROR, EVENTS_EXTENSION, SENDER_META } from '@metro-labs/http/mcp-events';
import { isWebhookSecret, webhookSignature } from '@metro-labs/http/standard-webhooks';
import { HOST, listen } from './helpers.ts';

const DAY_MS = 24 * 60 * 60_000;
const MIN_TTL_MS = 10 * 60_000;
const DUAL_SIGN_MS = 10 * 60_000;

export interface EventsRequest {
  method: string;
  params: Record<string, unknown>;
  headers: IncomingMessage['headers'];
}

interface ServerSubscription {
  id: string;
  name: string;
  url: string;
  secret: string;
  previous: { secret: string; until: number } | null;
  expiresAt: number;
  cursor: string | null;
}

interface Posted {
  status: number;
  body: string;
}

interface PostOptions {
  id?: string;
  timestamp?: number;
  secrets?: string[];
  signature?: string;
  subscriptionId?: string;
  omit?: string[];
  raw?: string;
}

export interface FakeEventsServer {
  base: string;
  requests: EventsRequest[];
  subscriptions: Map<string, ServerSubscription>;
  verifications: string[];
  state: {
    accepted: string;
    principal: string;
    declares: boolean;
    events: Record<string, unknown>[];
    signedOut: boolean;
    refuse: ((params: Record<string, unknown>) => { code: number; message: string; data?: Record<string, unknown> } | null) | null;
    cursor: string | null;
    truncated: boolean;
    grantMs: number | null;
    metro: string;
    now: () => number;
  };
  post: (subscription: ServerSubscription, body: unknown, options?: PostOptions) => Promise<Posted>;
  deliver: (subscription: ServerSubscription, event: { eventId: string; data: Record<string, unknown>; cursor?: string | null; name?: string; timestamp?: string }, options?: PostOptions) => Promise<Posted>;
  only: () => ServerSubscription;
  close: () => Promise<void>;
}

export const MAIL_EVENT = {
  name: 'email.received',
  description: 'A new email arrived in the inbox.',
  delivery: ['webhook'],
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  _meta: { [SENDER_META]: { id: '/from/address', verified: '/senderVerified' } },
};

export const PLAIN_EVENT = { name: 'page.updated', title: 'Page changed', description: 'A page was edited.', delivery: ['webhook', 'poll'] };

const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => (item !== null && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : 1))) : item));

class RpcError extends Error {
  constructor(readonly code: number, message: string, readonly data?: Record<string, unknown>) {
    super(message);
  }
}

async function bodyOf(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function checkUrl(raw: unknown): string {
  let url: URL;
  try {
    url = new URL(typeof raw === 'string' ? raw : '');
  } catch {
    throw new RpcError(EVENT_ERROR.invalidParams, 'delivery.url is not a url');
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || isIP(url.hostname.replace(/^\[|\]$/g, '')) !== 0) throw new RpcError(EVENT_ERROR.invalidParams, 'delivery.url must be https, with no user information and no IP literal');
  return url.toString();
}

export async function startEventsServer(): Promise<FakeEventsServer> {
  const server: Omit<FakeEventsServer, 'base' | 'close'> = {
    requests: [],
    subscriptions: new Map(),
    verifications: [],
    state: { accepted: 'Bearer VENDOR_KEY', principal: 'mailbox-1', declares: true, events: [MAIL_EVENT, PLAIN_EVENT], signedOut: false, refuse: null, cursor: 'cursor-0', truncated: false, grantMs: null, metro: '', now: Date.now },
    post: async (subscription, body, options = {}) => {
      const raw = options.raw ?? JSON.stringify(body);
      const id = options.id ?? `msg_${randomBytes(12).toString('base64url')}`;
      const timestamp = options.timestamp ?? Math.floor(server.state.now() / 1000);
      const secrets = options.secrets ?? [subscription.secret, ...(subscription.previous !== null && subscription.previous.until > server.state.now() ? [subscription.previous.secret] : [])];
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'webhook-id': id,
        'webhook-timestamp': String(timestamp),
        'webhook-signature': options.signature ?? secrets.map((secret) => webhookSignature(secret, id, timestamp, raw)).join(' '),
        'x-mcp-subscription-id': options.subscriptionId ?? subscription.id,
      };
      for (const name of options.omit ?? []) Reflect.deleteProperty(headers, name);
      const res = await fetch(subscription.url.replace(`https://${HOST}`, server.state.metro), { method: 'POST', redirect: 'manual', headers, body: raw, signal: AbortSignal.timeout(10_000) });
      return { status: res.status, body: await res.text() };
    },
    deliver: (subscription, event, options) =>
      server.post(subscription, { eventId: event.eventId, name: event.name ?? subscription.name, timestamp: event.timestamp ?? new Date(server.state.now()).toISOString(), data: event.data, ...(event.cursor === undefined ? {} : { cursor: event.cursor }) }, options),
    only: () => {
      const all = [...server.subscriptions.values()];
      if (all.length !== 1 || all[0] === undefined) throw new Error(`expected one subscription, found ${String(all.length)}`);
      return all[0];
    },
  };
  const verified = new Set<string>();

  const handshake = async (subscription: ServerSubscription): Promise<void> => {
    const challenge = randomBytes(16).toString('base64url');
    server.verifications.push(subscription.id);
    let posted: Posted;
    try {
      posted = await server.post(subscription, { type: 'verification', challenge }, { id: `msg_verification_${randomBytes(8).toString('base64url')}`, secrets: [subscription.secret] });
    } catch {
      throw new RpcError(EVENT_ERROR.callbackEndpoint, 'CallbackEndpointError', { reason: 'connection_refused' });
    }
    let echoed = '';
    try {
      echoed = String((JSON.parse(posted.body) as { challenge?: unknown }).challenge ?? '');
    } catch {
      echoed = '';
    }
    const same = echoed.length === challenge.length && timingSafeEqual(Buffer.from(echoed), Buffer.from(challenge));
    if (posted.status < 200 || posted.status >= 300 || !same) throw new RpcError(EVENT_ERROR.callbackEndpoint, 'CallbackEndpointError', { reason: 'challenge_failed' });
  };

  const subscribe = async (params: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if (server.state.signedOut) throw new RpcError(EVENT_ERROR.forbidden, 'Forbidden', { reason: 'signed_out' });
    const refusal = server.state.refuse?.(params) ?? null;
    if (refusal !== null) throw new RpcError(refusal.code, refusal.message, refusal.data);
    const offered = server.state.events.find((event) => event.name === params.name);
    if (offered === undefined) throw new RpcError(EVENT_ERROR.notFound, 'NotFound', { kind: 'event' });
    const delivery = (params.delivery ?? {}) as Record<string, unknown>;
    if (delivery.mode !== 'webhook') throw new RpcError(EVENT_ERROR.unsupported, 'Unsupported', { feature: 'deliveryMode' });
    if (canonical(params.arguments) !== '{}') throw new RpcError(EVENT_ERROR.invalidParams, 'arguments must be {}');
    const url = checkUrl(delivery.url);
    if (typeof delivery.secret !== 'string' || !isWebhookSecret(delivery.secret)) throw new RpcError(EVENT_ERROR.invalidParams, 'delivery.secret is not a whsec_ value');
    const key = canonical([server.state.principal, url, params.name, params.arguments]);
    const id = `sub_${createHash('sha256').update(key).digest('hex').slice(0, 24)}`;
    const now = server.state.now();
    const held = server.subscriptions.get(key);
    const asked = typeof params.ttlMs === 'number' ? params.ttlMs : DAY_MS;
    const granted = server.state.grantMs ?? Math.max(MIN_TTL_MS, Math.min(asked, DAY_MS));
    const next: ServerSubscription = {
      id,
      name: String(params.name),
      url,
      secret: delivery.secret,
      previous: held !== undefined && held.secret !== delivery.secret ? { secret: held.secret, until: now + DUAL_SIGN_MS } : (held?.previous ?? null),
      expiresAt: now + granted,
      cursor: typeof params.cursor === 'string' ? params.cursor : null,
    };
    const principalUrl = canonical([server.state.principal, url]);
    if (!verified.has(principalUrl)) {
      await handshake(next);
      verified.add(principalUrl);
    }
    server.subscriptions.set(key, next);
    return {
      resultType: 'complete',
      id,
      refreshBefore: new Date(next.expiresAt).toISOString(),
      cursor: server.state.cursor,
      truncated: server.state.truncated,
      ...(held === undefined ? {} : { deliveryStatus: { active: true, lastDeliveryAt: null, lastError: null } }),
    };
  };

  const unsubscribe = (params: Record<string, unknown>): Record<string, unknown> => {
    const delivery = (params.delivery ?? {}) as Record<string, unknown>;
    const key = canonical([server.state.principal, checkUrl(delivery.url), params.name, params.arguments]);
    if (!server.subscriptions.delete(key)) throw new RpcError(EVENT_ERROR.notFound, 'NotFound', { kind: 'subscription' });
    return { resultType: 'complete' };
  };

  const answer = async (method: string, params: Record<string, unknown>): Promise<Record<string, unknown> | null> => {
    if (method === 'initialize') return { protocolVersion: '2025-11-25', capabilities: { tools: {}, ...(server.state.declares ? { extensions: { [EVENTS_EXTENSION]: {} } } : {}) }, serverInfo: { name: 'events-vendor' } };
    if (method === 'tools/list') return { tools: [{ name: 'read', description: 'Read one item.', annotations: { readOnlyHint: true } }] };
    if (!method.startsWith('events/')) return null;
    if (!server.state.declares) throw new RpcError(-32601, 'Method not found');
    if (method === 'events/list') return { resultType: 'complete', events: server.state.events };
    if (method === 'events/subscribe') return subscribe(params);
    if (method === 'events/unsubscribe') return unsubscribe(params);
    throw new RpcError(-32601, 'Method not found');
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
    const message = JSON.parse(text) as { id?: number; method: string; params?: Record<string, unknown> };
    if (message.method.startsWith('events/')) server.requests.push({ method: message.method, params: message.params ?? {}, headers: req.headers });
    if (message.method === 'notifications/initialized') {
      res.writeHead(202).end();
      return;
    }
    const reply = (body: Record<string, unknown>): void => {
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'events-session' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, ...body }));
    };
    try {
      const result = await answer(message.method, message.params ?? {});
      if (result === null) res.writeHead(404).end();
      else reply({ result });
    } catch (err) {
      if (!(err instanceof RpcError)) throw err;
      reply({ error: { code: err.code, message: err.message, ...(err.data === undefined ? {} : { data: err.data }) } });
    }
  };

  const started = await listen((req, res) => {
    handle(req, res).catch(() => {
      res.writeHead(500).end();
    });
  });
  return { ...server, base: started.base, close: started.close };
}
