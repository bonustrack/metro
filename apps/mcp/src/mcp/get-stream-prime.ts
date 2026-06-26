import type { IncomingMessage, ServerResponse } from 'node:http';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const STANDALONE_STREAM_ID = '_GET_stream';
const PRIME_POLL_MS = 5;
const PRIME_POLL_MAX = 200;
export const GET_KEEPALIVE_MS = 15_000;
const COMMENT = ':\n\n';

interface StreamEntry {
  controller: { enqueue: (chunk: Uint8Array) => void };
  encoder: { encode: (input: string) => Uint8Array };
}

interface WebTransport {
  _streamMapping?: Map<string, StreamEntry>;
}

interface AdaptedTransport {
  _webStandardTransport?: WebTransport;
}

const standaloneEntry = (
  transport: StreamableHTTPServerTransport,
): StreamEntry | undefined => {
  const inner = (transport as unknown as AdaptedTransport)._webStandardTransport;
  return inner?._streamMapping?.get(STANDALONE_STREAM_ID);
};

const writeComment = (entry: StreamEntry): boolean => {
  try {
    entry.controller.enqueue(entry.encoder.encode(COMMENT));
    return true;
  } catch {
    return false;
  }
};

export function primeGetStream(opts: {
  transport: StreamableHTTPServerTransport;
  res: ServerResponse;
  req: IncomingMessage;
  keepaliveMs?: number;
  log: (...a: unknown[]) => void;
}): void {
  const { transport, res, req, log } = opts;
  const keepaliveMs = opts.keepaliveMs ?? GET_KEEPALIVE_MS;
  let timer: ReturnType<typeof setInterval> | undefined;
  let polls = 0;
  const stop = (): void => {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
  res.on('close', stop);
  req.on('close', stop);
  const begin = (entry: StreamEntry): void => {
    if (!writeComment(entry)) return;
    timer = setInterval(() => {
      const live = standaloneEntry(transport) ?? entry;
      if (!writeComment(live)) stop();
    }, keepaliveMs);
    if (typeof timer.unref === 'function') timer.unref();
  };
  const poll = setInterval(() => {
    if (res.writableEnded || timer !== undefined) {
      clearInterval(poll);
      return;
    }
    const entry = standaloneEntry(transport);
    if (entry) {
      clearInterval(poll);
      begin(entry);
      return;
    }
    polls += 1;
    if (polls >= PRIME_POLL_MAX) {
      clearInterval(poll);
      log('get-stream prime: standalone stream never appeared');
    }
  }, PRIME_POLL_MS);
  if (typeof poll.unref === 'function') poll.unref();
}
