import { describe, expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { EventEmitter } from 'node:events';
import {
  isStandaloneGet,
  serveStandaloneGet,
  validateStandaloneSession,
} from '../src/mcp/raw-get-stream.ts';
import { BoundedEventStore } from '../src/mcp/event-store.ts';

type FakeTransport = {
  _webStandardTransport: {
    sessionId?: string;
    _initialized?: boolean;
    _streamMapping: Map<string, unknown>;
  };
};

const fakeTransport = (
  sessionId: string | undefined,
  initialized: boolean,
): FakeTransport => ({
  _webStandardTransport: {
    sessionId,
    _initialized: initialized,
    _streamMapping: new Map(),
  },
});

const fakeReq = (
  method: string,
  headers: Record<string, string>,
): IncomingMessage => {
  const e = new EventEmitter() as unknown as IncomingMessage;
  (e as { method?: string }).method = method;
  (e as { headers?: Record<string, string> }).headers = headers;
  return e;
};

describe('isStandaloneGet', () => {
  test('true for GET with text/event-stream accept', () => {
    expect(
      isStandaloneGet(fakeReq('GET', { accept: 'text/event-stream' })),
    ).toBe(true);
  });
  test('false for POST', () => {
    expect(
      isStandaloneGet(fakeReq('POST', { accept: 'text/event-stream' })),
    ).toBe(false);
  });
  test('false for GET without sse accept', () => {
    expect(isStandaloneGet(fakeReq('GET', { accept: 'application/json' }))).toBe(
      false,
    );
  });
});

describe('validateStandaloneSession', () => {
  test('400 when not initialized', () => {
    const r = validateStandaloneSession(
      fakeTransport('s1', false) as never,
      fakeReq('GET', { 'mcp-session-id': 's1' }),
    );
    expect(r).toEqual({
      ok: false,
      status: 400,
      message: 'Bad Request: Server not initialized',
    });
  });
  test('400 when session id missing', () => {
    const r = validateStandaloneSession(
      fakeTransport('s1', true) as never,
      fakeReq('GET', {}),
    );
    expect(r.status).toBe(400);
  });
  test('404 when session id mismatches', () => {
    const r = validateStandaloneSession(
      fakeTransport('s1', true) as never,
      fakeReq('GET', { 'mcp-session-id': 'other' }),
    );
    expect(r.status).toBe(404);
  });
  test('ok when session id matches', () => {
    const r = validateStandaloneSession(
      fakeTransport('s1', true) as never,
      fakeReq('GET', { 'mcp-session-id': 's1' }),
    );
    expect(r.ok).toBe(true);
  });
});

describe('serveStandaloneGet', () => {
  test('writes headers + priming comment, registers sink, replays last-event-id', async () => {
    const eventStore = new BoundedEventStore();
    const id = await eventStore.storeEvent('_GET_stream', {
      jsonrpc: '2.0',
      method: 'notifications/claude/channel',
      params: { content: 'replayed' },
    } as never);
    const after = await eventStore.storeEvent('_GET_stream', {
      jsonrpc: '2.0',
      method: 'notifications/claude/channel',
      params: { content: 'newer' },
    } as never);
    expect(after).not.toBe(id);

    const transport = fakeTransport('s1', true);
    const out = new PassThrough();
    let body = '';
    out.on('data', (c: Buffer) => {
      body += c.toString('utf8');
    });
    const res = out as unknown as ServerResponse & { headers?: unknown };
    let head: unknown;
    (res as { writeHead: unknown }).writeHead = (s: number, h: unknown) => {
      head = { s, h };
      return res;
    };
    (res as { flushHeaders?: () => void }).flushHeaders = () => undefined;

    const req = fakeReq('GET', {
      accept: 'text/event-stream',
      'mcp-session-id': 's1',
      'last-event-id': id,
    });

    let sinkSeen: unknown;
    await serveStandaloneGet({
      transport: transport as never,
      eventStore,
      req,
      res,
      log: () => undefined,
      registerSink: (s) => {
        sinkSeen = s;
      },
    });

    expect(sinkSeen).toBeDefined();
    expect((head as { s: number }).s).toBe(200);
    expect(body.startsWith(':\n\n')).toBe(true);
    expect(body).toContain('"content":"newer"');
    expect(body).not.toContain('"content":"replayed"');

    const mapping = transport._webStandardTransport._streamMapping;
    const entry = mapping.get('_GET_stream') as {
      controller: { enqueue: (c: Uint8Array) => void };
      encoder: { encode: (s: string) => Uint8Array };
    };
    expect(entry).toBeDefined();

    const frame =
      'event: message\nid: x\ndata: {"jsonrpc":"2.0","method":"notifications/claude/channel"}\n\n';
    entry.controller.enqueue(entry.encoder.encode(frame));
    expect(body).toContain(frame);

    req.emit('close');
    expect(mapping.get('_GET_stream')).toBeUndefined();
  });
});
