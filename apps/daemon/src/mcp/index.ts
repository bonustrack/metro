import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  BodyTooLargeError,
  readBody as readBodyBuffer,
} from '../routes/http.js';
import {
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
import { SessionSlot } from './session-slot.js';

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

const NO_SESSION_HEADER = 'Bad Request: Mcp-Session-Id header is required';

async function resolveSession(
  slot: SessionSlot,
  req: IncomingMessage,
  body: unknown,
  identity: RequestIdentity,
  res: ServerResponse,
): Promise<McpSession | undefined> {
  if (isInitialize(body)) return slot.open(identity);
  const presented = headerValue(req, 'mcp-session-id');
  const current = slot.current;
  if (presented === undefined) {
    if (current) return current;
    channelLog('session: refused, no Mcp-Session-Id and no session');
    res.writeHead(400).end(NO_SESSION_HEADER);
    return undefined;
  }
  if (current?.id === presented) return current;
  return slot.open(identity, presented);
}

async function serveGet(
  session: McpSession,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const served = await serveChannelGet({
    transport: session.transport,
    eventStore: session.eventStore,
    scope: session.scope,
    req,
    res,
    previous: session.currentSink,
    log: channelLog,
    registerSink: (sink) => {
      session.bindSink(sink);
    },
  });
  if (served) session.channel.replayMissed();
}

let activeSlot: SessionSlot | undefined;

export async function createMetroMcp(): Promise<{
  httpHandler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  startInbound: () => void;
}> {
  await activeSlot?.close();
  const slot = new SessionSlot();
  activeSlot = slot;

  const httpHandler = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    const identity = authenticate(req);
    if (!identity) {
      res.writeHead(401).end('unauthorized');
      return;
    }
    const parsed = await readOrReject(req, res);
    if (!parsed.ok) return;
    await runWithIdentity(identity, async () => {
      const session = await resolveSession(
        slot,
        req,
        parsed.body,
        identity,
        res,
      );
      if (!session) return;
      if (isStandaloneGet(req)) {
        await serveGet(session, req, res);
        return;
      }
      await session.transport.handleRequest(req, res, parsed.body);
    });
  };

  const startInbound = (): void => {
    slot.startInbound();
    channelLog('inbound: bus subscription (bounded replay on reconnect)');
  };

  return { httpHandler, startInbound };
}
