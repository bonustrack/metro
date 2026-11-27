import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  BodyTooLargeError,
  readBody as readBodyBuffer,
} from '../routes/http.js';
import {
  authenticate,
  runWithIdentity,
  type RequestIdentity,
  allowedAgents,
} from './request-identity.js';
import {
  headerValue,
  isStandaloneGet,
  serveChannelGet,
} from './raw-get-stream.js';
import { errMsg } from '@metro-labs/core/log';
import { isRecord } from '@metro-labs/core/is-record';
import { CHAT_MCP_HEADER } from '@metro-labs/core/chat';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { channelLog, RUNNER_CLIENT, type McpSession } from './session.js';
import { SessionSlot } from './session-slot.js';
import { SideSessions } from './side-sessions.js';
import { connectCallBridge } from './call-bridge.js';
import { connectOwnerRoute, type OwnerRoute } from './owner-route.js';
import { relayLine } from './permission-relay.js';
import { publishEvent } from '@metro-labs/core/events';
import { handleIncomingDiagnostic } from './diagnostics.js';
import { onConnectorToolsChanged } from '../mcp-server/connector-tools.js';

const isInitialize = (b: unknown): boolean => isRecord(b) && b.method === 'initialize';

const clientName = (b: unknown): string | undefined => {
  if (!isRecord(b) || !isRecord(b.params) || !isRecord(b.params.clientInfo)) return undefined;
  const name = b.params.clientInfo.name;
  return typeof name === 'string' ? name : undefined;
};

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
const SIDE_NO_STREAM = 'Method Not Allowed: only the agent session receives channel messages; this session can list and call tools';

type Routed = { main: McpSession } | { side: StreamableHTTPServerTransport };

async function resolveSession(
  slot: SessionSlot,
  sides: SideSessions,
  req: IncomingMessage,
  body: unknown,
  identity: RequestIdentity,
  res: ServerResponse,
): Promise<Routed | undefined> {
  const current = slot.current;
  const held = current?.heldByRunner === true;
  const presented = headerValue(req, 'mcp-session-id');
  if (headerValue(req, CHAT_MCP_HEADER) !== undefined) return { side: await chatSide(sides, isInitialize(body) ? undefined : presented) };
  if (isInitialize(body)) {
    if (held && clientName(body) !== RUNNER_CLIENT) return { side: await sides.start() };
    return { main: await slot.open(identity) };
  }
  if (presented !== undefined) return byId(slot, sides, presented, identity);
  if (current) return { main: current };
  channelLog('session: refused, no Mcp-Session-Id and no session');
  res.writeHead(400).end(NO_SESSION_HEADER);
  return undefined;
}

const chatSide = (sides: SideSessions, presented: string | undefined): Promise<StreamableHTTPServerTransport> => {
  const found = presented === undefined ? undefined : sides.find(presented);
  return found === undefined ? sides.start(presented, true) : Promise.resolve(found);
};

async function byId(slot: SessionSlot, sides: SideSessions, presented: string, identity: RequestIdentity): Promise<Routed> {
  const current = slot.current;
  if (current?.id === presented) return { main: current };
  const side = sides.find(presented);
  if (side !== undefined) return { side };
  if (current?.heldByRunner === true) return { side: await sides.start(presented) };
  return { main: await slot.open(identity, presented) };
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
    previous: () => session.currentSink,
    log: channelLog,
    registerSink: (sink) => {
      session.bindSink(sink);
    },
  });
  if (served) session.replayMissed();
}

let activeSlot: SessionSlot | undefined;
let activeSides: SideSessions | undefined;
let stopToolNotices: (() => void) | undefined;

const MODEL_NOTICE = 'notifications/metro/model';

function noticeModel(session: McpSession | undefined, model: string | null): boolean {
  if (session?.streamAttached !== true) return false;
  session.server.notification({ method: MODEL_NOTICE, params: { model } }).catch((err: unknown) => {
    channelLog('session: the model notice failed', errMsg(err));
  });
  return true;
}

function promptLineIn(session: McpSession | undefined, requestId: string, callLine?: string): string | undefined {
  if (session === undefined) return undefined;
  return relayLine({ relay: session.relay, inScope: (line) => session.inScope(line), live: session.live, log: channelLog }, requestId, callLine);
}

export async function createMetroMcp(options: { liveEvents?: boolean; publish?: OwnerRoute['publish'] } = {}): Promise<{
  httpHandler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  startInbound: () => void;
  setLiveEvents: (on: boolean) => void;
  switchModel: (model: string | null) => boolean;
}> {
  await activeSlot?.close();
  await activeSides?.closeAll();
  const slot = new SessionSlot(options.liveEvents);
  activeSlot = slot;
  const sides = new SideSessions((id) => {
    slot.current?.relay.noteSent(id);
  });
  activeSides = sides;
  stopToolNotices?.();
  stopToolNotices = onConnectorToolsChanged(() => {
    slot.current?.toolsChanged();
  });
  connectCallBridge(() => slot.current);
  connectOwnerRoute({
    promptLine: (requestId, callLine) => promptLineIn(slot.current, requestId, callLine),
    knownLine: () => slot.current?.relay.knownLine,
    live: () => slot.liveEvents,
    publish: options.publish ?? publishEvent,
  });

  const httpHandler = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    const identity = authenticate(req);
    if (!identity) {
      res.writeHead(401).end('unauthorized');
      return;
    }
    if (handleIncomingDiagnostic(req, res, slot, allowedAgents(identity))) return;
    const parsed = await readOrReject(req, res);
    if (!parsed.ok) return;
    await runWithIdentity(identity, async () => {
      const routed = await resolveSession(slot, sides, req, parsed.body, identity, res);
      if (!routed) return;
      if ('side' in routed) {
        if (isStandaloneGet(req)) res.writeHead(405).end(SIDE_NO_STREAM);
        else {
          sides.serving(routed.side, res);
          await routed.side.handleRequest(req, res, parsed.body);
        }
        return;
      }
      if (isStandaloneGet(req)) {
        await serveGet(routed.main, req, res);
        return;
      }
      await routed.main.transport.handleRequest(req, res, parsed.body);
    });
  };

  const startInbound = (): void => {
    slot.startInbound();
    channelLog(
      slot.liveEvents
        ? 'inbound: bus subscription (bounded replay on reconnect)'
        : 'inbound: live events are off, nothing is pushed to the session',
    );
  };

  const setLiveEvents = (on: boolean): void => {
    slot.setLive(on);
  };

  const switchModel = (model: string | null): boolean => noticeModel(slot.current, model);

  return { httpHandler, startInbound, setLiveEvents, switchModel };
}
