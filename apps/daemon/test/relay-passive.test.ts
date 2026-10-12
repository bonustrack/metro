import { expect, test } from 'bun:test';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { PassiveSseListener, passiveRelayListener } from '../src/connectors/relay-passive.js';
import type { MigrationOperation } from '../src/connectors/migration-operations.js';

const rpc = (method: string, params?: unknown) => JSON.stringify({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
const bytes = (text: string) => new TextEncoder().encode(text);

for (const newline of ['\n', '\r\n', '\r']) {
  test(`passive SSE accepts empty streams, heartbeats and known notifications across ${JSON.stringify(newline)} chunk boundaries`, () => {
    const listener = new PassiveSseListener();
    expect(listener.idle()).toBe(true);
    const messages = [rpc('notifications/tools/list_changed'), rpc('notifications/prompts/list_changed'), rpc('notifications/resources/list_changed'), rpc('notifications/resources/updated', { uri: 'fixture://item' }), rpc('notifications/message', { level: 'info', data: 'Héllo' })];
    const text = `: ping${newline}${newline}` + messages.map((data) => `event: message${newline}data: ${data}${newline}${newline}`).join('');
    for (const byte of bytes(text)) listener.observe(new Uint8Array([byte]));
    expect(listener.idle()).toBe(true);
  });
}

test('long-lived comment-only heartbeats do not accumulate an event or prevent drain', () => {
  const listener = new PassiveSseListener();
  for (let count = 0; count < 100; count += 1) listener.observe(bytes(`: ${'x'.repeat(1000)}\n`));
  expect(listener.idle()).toBe(true);
  listener.forwarding = true;
  expect(listener.idle()).toBe(false);
  listener.forwarding = false;
  expect(listener.idle()).toBe(true);
});

test('partial bytes and data cannot become idle until the event is complete', () => {
  const listener = new PassiveSseListener();
  listener.observe(bytes('data: {"jsonrpc":"2.0",\n'));
  expect(listener.idle()).toBe(false);
  listener.observe(bytes('data: "method":"notifications/tools/list_changed"}\n'));
  expect(listener.idle()).toBe(false);
  listener.observe(bytes('\n'));
  expect(listener.idle()).toBe(true);
  listener.observe(new Uint8Array([0xc3]));
  expect(listener.idle()).toBe(false);
});

const unsafe = [
  'id: cursor\n\n', 'id:\n\n', 'event: endpoint\n\n', 'unknown: x\n\n', 'retry: invalid\n\n',
  'data: []\n\n', 'data: {}\n\n', 'data: broken\n\n',
  'data: {"method":"notifications/tools/list_changed"}\n\n',
  'data: {"jsonrpc":"1.0","method":"notifications/tools/list_changed"}\n\n',
  'data: {"jsonrpc":"2.0","method":"notifications/tools/list_changed","extra":true}\n\n',
  'data: {"jsonrpc":"2.0","method":"notifications/tools/list_changed","id":null}\n\n',
  'data: {"jsonrpc":"2.0","method":"notifications/tools/list_changed","result":{}}\n\n',
  'data: {"jsonrpc":"2.0","id":1,"error":{"code":-1,"message":"failed"}}\n\n',
  `data: ${rpc('notifications/custom')}\n\n`,
  `data: ${rpc('notifications/progress', { progressToken: 1, progress: 1 })}\n\n`,
  `data: ${rpc('notifications/message')}\n\n`,
  `data: ${rpc('sampling/createMessage')}\n\n`,
];
for (const text of unsafe) {
  test(`non-passive SSE remains protected after later heartbeats: ${text.trim()}`, () => {
    const listener = new PassiveSseListener();
    listener.observe(bytes(text));
    listener.observe(bytes(': idle\n\n'));
    expect(listener.idle()).toBe(false);
  });
}

test('a near-limit notification can arrive byte by byte without rescanning its prefix', () => {
  const listener = new PassiveSseListener();
  const text = `data: ${rpc('notifications/message', { level: 'info', data: 'x'.repeat(60_000) })}\n\n`;
  for (const byte of bytes(text)) listener.observe(new Uint8Array([byte]));
  expect(listener.idle()).toBe(true);
});

test('inspection is bounded and invalid UTF-8 cannot be silently classified as passive', () => {
  for (const chunk of [bytes('x'.repeat(65_537)), bytes(`: ${'x'.repeat(65_537)}\n\n`), new Uint8Array([0xff, 10, 10])]) {
    const listener = new PassiveSseListener();
    listener.observe(chunk);
    listener.observe(bytes(': idle\n\n'));
    expect(listener.idle()).toBe(false);
  }
});

test('passive candidates stay busy while downstream writes are buffered', () => {
  const req = new IncomingMessage(new Socket());
  req.method = 'GET';
  const res = new ServerResponse(req);
  let idle = () => false;
  const operation: MigrationOperation = {
    passiveListener: (listener) => { idle = listener.idle; }, dispatch: (send) => send(), close: () => {}, persistedRefresh: () => {},
  };
  const upstream = new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
  const listener = passiveRelayListener(req, res, upstream, operation, () => {});
  expect(listener).toBeDefined();
  expect(idle()).toBe(true);
  Object.defineProperty(res, 'writableLength', { configurable: true, value: 42 });
  expect(idle()).toBe(false);
  Object.defineProperty(res, 'writableLength', { configurable: true, value: 0 });
  expect(idle()).toBe(true);
  res.destroy(); req.destroy();
});
