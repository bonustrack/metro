import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  StreamableHTTPServerTransport,
  EventId,
} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { BoundedEventStore } from './event-store.js';

const STANDALONE_STREAM_ID = '_GET_stream';
const KEEPALIVE_MS = 15_000;
const RECONNECT_RETRY_MS = 15_000;
const COMMENT = ':\n\n';
const RETRY_DIRECTIVE = `retry: ${RECONNECT_RETRY_MS}\n\n`;

interface StreamEntry {
  controller: { enqueue: (chunk: Uint8Array) => void };
  encoder: { encode: (input: string) => Uint8Array };
  cleanup: () => void;
}

interface WebTransport {
  sessionId?: string;
  _initialized?: boolean;
  _streamMapping?: Map<string, StreamEntry>;
}

interface AdaptedTransport {
  _webStandardTransport?: WebTransport;
}

const web = (
  transport: StreamableHTTPServerTransport,
): WebTransport | undefined =>
  (transport as unknown as AdaptedTransport)._webStandardTransport;

export const isStandaloneGet = (req: IncomingMessage): boolean => {
  if (req.method !== 'GET') return false;
  const accept = req.headers.accept;
  const value = Array.isArray(accept) ? accept.join(',') : (accept ?? '');
  return value.includes('text/event-stream');
};

const headerValue = (
  req: IncomingMessage,
  name: string,
): string | undefined => {
  const raw = req.headers[name];
  if (Array.isArray(raw)) return raw[0];
  return typeof raw === 'string' ? raw : undefined;
};

export interface RawGetSink {
  closed: boolean;
  attach: (transport: StreamableHTTPServerTransport) => void;
}

export interface ValidateResult {
  ok: boolean;
  status?: number;
  message?: string;
}

export function validateStandaloneSession(
  transport: StreamableHTTPServerTransport,
  req: IncomingMessage,
): ValidateResult {
  const inner = web(transport);
  if (!inner) return { ok: false, status: 500, message: 'transport not ready' };
  if (!inner._initialized)
    return {
      ok: false,
      status: 400,
      message: 'Bad Request: Server not initialized',
    };
  const presented = headerValue(req, 'mcp-session-id');
  if (!presented)
    return {
      ok: false,
      status: 400,
      message: 'Bad Request: Mcp-Session-Id header is required',
    };
  if (presented !== inner.sessionId)
    return { ok: false, status: 404, message: 'Session not found' };
  return { ok: true };
}

interface ServeOpts {
  transport: StreamableHTTPServerTransport;
  eventStore: BoundedEventStore;
  req: IncomingMessage;
  res: ServerResponse;
  log: (...a: unknown[]) => void;
  registerSink: (sink: RawGetSink | undefined) => void;
}

export async function serveStandaloneGet(opts: ServeOpts): Promise<void> {
  const { transport, eventStore, req, res, log, registerSink } = opts;
  const sessionId = web(transport)?.sessionId;

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
  });
  res.flushHeaders?.();
  res.write(RETRY_DIRECTIVE);
  res.write(COMMENT);

  let active = transport;
  const sink: RawGetSink = {
    closed: false,
    attach: (next: StreamableHTTPServerTransport): void => {
      active = next;
      const entry: StreamEntry = {
        controller: {
          enqueue: (chunk: Uint8Array): void => {
            if (!sink.closed) res.write(Buffer.from(chunk));
          },
        },
        encoder: { encode: (input: string): Uint8Array => Buffer.from(input) },
        cleanup: (): void => undefined,
      };
      web(next)?._streamMapping?.set(STANDALONE_STREAM_ID, entry);
    },
  };

  const lastEventId = headerValue(req, 'last-event-id');
  if (lastEventId) {
    await eventStore.replayEventsAfter(lastEventId, {
      send: (id: EventId, message: JSONRPCMessage): Promise<void> => {
        if (!sink.closed)
          res.write(`event: message\nid: ${id}\ndata: ${JSON.stringify(message)}\n\n`);
        return Promise.resolve();
      },
    });
  }

  sink.attach(transport);
  registerSink(sink);

  const keepalive = setInterval(() => {
    if (!sink.closed) res.write(COMMENT);
  }, KEEPALIVE_MS);
  keepalive.unref?.();

  const cleanup = (): void => {
    if (sink.closed) return;
    sink.closed = true;
    clearInterval(keepalive);
    web(active)?._streamMapping?.delete(STANDALONE_STREAM_ID);
    registerSink(undefined);
    try {
      res.end();
    } catch {
      log('raw-get-stream: end failed');
    }
  };
  res.on('close', cleanup);
  res.on('error', cleanup);
  req.on('close', cleanup);
}
