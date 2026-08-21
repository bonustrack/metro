import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  BodyTooLargeError,
  readBody as readBodyBuffer,
} from '../daemon/http.js';
import {
  allowedAgents,
  authConfigFromEnv,
  authenticate,
  runWithIdentity,
  type RequestIdentity,
} from './request-identity.js';
import {
  headerValue,
  isStandaloneGet,
  serveChannelGet,
} from './raw-get-stream.js';
import { channelLog, type McpSession } from './session.js';
import { SessionCapacityError, SessionRegistry } from './session-registry.js';
import { routeSession, sessionScopeKey } from './session-route.js';

const isInitialize = (b: unknown): boolean =>
  !!b &&
  typeof b === 'object' &&
  (b as { method?: string }).method === 'initialize';

const MCP_BODY_MAX = 32 * 1024 * 1024;

async function readBody(req: IncomingMessage): Promise<unknown> {
  const raw = (await readBodyBuffer(req, MCP_BODY_MAX)).toString('utf8');
  try {
    return raw ? JSON.parse(raw) : undefined;
  } catch {
    return undefined;
  }
}

type ParsedBody = { ok: true; body: unknown } | { ok: false };

async function readOrReject(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<ParsedBody> {
  try {
    const body = req.method === 'POST' ? await readBody(req) : undefined;
    return { ok: true, body };
  } catch (err) {
    if (!(err instanceof BodyTooLargeError)) throw err;
    res.writeHead(413).end('payload too large');
    return { ok: false };
  }
}

async function resolveSession(
  registry: SessionRegistry,
  req: IncomingMessage,
  body: unknown,
  identity: RequestIdentity,
  res: ServerResponse,
): Promise<McpSession | undefined> {
  const presented = headerValue(req, 'mcp-session-id');
  const scopeKey = sessionScopeKey(identity);
  const route = routeSession({
    isInitialize: isInitialize(body),
    presented,
    ownership: registry.ownership(presented, scopeKey),
    hasOwnSession: registry.forScope(scopeKey) !== undefined,
  });
  if (route.kind === 'reject') {
    channelLog(
      'session: refused',
      'status',
      route.status,
      'presented',
      presented ?? '(none)',
      'scope',
      scopeKey,
    );
    res.writeHead(route.status).end(route.message);
    return undefined;
  }
  if (route.kind === 'use') {
    const found =
      presented === undefined
        ? registry.forScope(scopeKey)
        : registry.get(presented);
    if (found) return found;
    res.writeHead(404).end('Session not found');
    return undefined;
  }
  try {
    return await registry.create(identity, route.adoptId);
  } catch (err) {
    if (!(err instanceof SessionCapacityError)) throw err;
    res.writeHead(503).end(err.message);
    return undefined;
  }
}

async function serveGet(
  session: McpSession,
  req: IncomingMessage,
  res: ServerResponse,
  identity: RequestIdentity,
): Promise<void> {
  if (session.currentSink && !session.owner.streamBelongsTo(identity)) {
    channelLog(
      'session: refused stream takeover',
      'session',
      session.id,
      'scope',
      session.scopeKey,
    );
    res.writeHead(409).end('Conflict: stream held by another identity');
    return;
  }
  const served = await serveChannelGet({
    transport: session.transport,
    eventStore: session.eventStore,
    scope: allowedAgents(identity),
    req,
    res,
    previous: session.currentSink,
    log: channelLog,
    registerSink: (sink) => {
      session.bindSink(sink, identity);
    },
  });
  if (served) session.channel.replayMissed();
}

let activeRegistry: SessionRegistry | undefined;

export async function closeAgentSession(agentId: string): Promise<boolean> {
  const scopeKey = sessionScopeKey({ kind: 'agent', agentId });
  return (await activeRegistry?.closeScope(scopeKey)) ?? false;
}

export async function createMetroMcp(): Promise<{
  httpHandler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  startInbound: () => void;
}> {
  await activeRegistry?.closeAll();
  const registry = new SessionRegistry(channelLog);
  activeRegistry = registry;

  const httpHandler = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    const identity = authenticate(req, authConfigFromEnv());
    if (!identity) {
      res.writeHead(401).end('unauthorized');
      return;
    }
    const parsed = await readOrReject(req, res);
    if (!parsed.ok) return;
    await runWithIdentity(identity, async () => {
      const session = await resolveSession(
        registry,
        req,
        parsed.body,
        identity,
        res,
      );
      if (!session) return;
      session.touch();
      if (isStandaloneGet(req)) {
        await serveGet(session, req, res, identity);
        return;
      }
      await session.transport.handleRequest(req, res, parsed.body);
    });
  };

  const startInbound = (): void => {
    registry.startInbound();
    channelLog(
      'inbound: per-session bus subscriptions (bounded replay on reconnect)',
    );
  };

  return { httpHandler, startInbound };
}
