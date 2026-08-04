import type { IncomingMessage, ServerResponse } from 'node:http';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { BoundedEventStore } from './event-store.js';
import {
  serveStandaloneGet,
  validateStandaloneSession,
  type RawGetSink,
} from './raw-get-stream.js';

export interface ChannelGetOpts {
  transport: StreamableHTTPServerTransport;
  eventStore: BoundedEventStore;
  scope: Set<number>;
  req: IncomingMessage;
  res: ServerResponse;
  previous: RawGetSink | undefined;
  log: (...a: unknown[]) => void;
  registerSink: (sink: RawGetSink | undefined) => void;
}

export async function serveChannelGet(opts: ChannelGetOpts): Promise<boolean> {
  const check = validateStandaloneSession(opts.transport, opts.req);
  if (!check.ok) {
    opts.res
      .writeHead(check.status ?? 400)
      .end(check.message ?? 'bad request');
    return false;
  }
  if (opts.previous && !opts.previous.closed) opts.previous.close();
  await serveStandaloneGet({
    transport: opts.transport,
    eventStore: opts.eventStore,
    scope: opts.scope,
    req: opts.req,
    res: opts.res,
    log: opts.log,
    registerSink: opts.registerSink,
  });
  return true;
}
