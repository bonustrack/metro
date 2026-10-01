import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { Utterance } from '../src/voice/speech.ts';

const saved = process.env.METRO_ELEVENLABS_URL;
let server: WebSocketServer;
let answer: (ws: WebSocket) => void = () => undefined;

beforeAll(async () => {
  server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  server.on('connection', (ws) => {
    answer(ws);
  });
  await new Promise<void>((r) => server.once('listening', r));
  process.env.METRO_ELEVENLABS_URL = `ws://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(() => {
  server.close();
  if (saved === undefined) delete process.env.METRO_ELEVENLABS_URL;
  else process.env.METRO_ELEVENLABS_URL = saved;
});

function speak(serve: (ws: WebSocket) => void, abort = false): Promise<string | null> {
  answer = serve;
  return new Promise((resolve) => {
    const utterance = new Utterance('key', 'voice', resolve);
    utterance.attach({ audio: () => undefined, done: () => undefined });
    if (abort) setTimeout(() => utterance.abort(), 20);
    setTimeout(() => resolve(null), 300);
  });
}

test('a refused key ends with ElevenLabs’ own reason', async () => {
  const reason = await speak((ws) => {
    ws.send(JSON.stringify({ message: 'Invalid API key', error: 'invalid_api_key', code: 1008 }));
    ws.close(1008, 'Invalid API key');
  });
  expect(reason).toBe('Invalid API key');
});

test('audio then a normal close is not a failure', async () => {
  const reason = await speak((ws) => {
    ws.send(JSON.stringify({ audio: Buffer.alloc(480).toString('base64') }));
    ws.send(JSON.stringify({ isFinal: true }));
    ws.close(1000);
  });
  expect(reason).toBeNull();
});

test('our own abort is not a failure', async () => {
  expect(await speak(() => undefined, true)).toBeNull();
});
