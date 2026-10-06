import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { Utterance } from '../src/voice/speech.ts';
import { Scribe } from '../src/voice/scribe.ts';

const saved = process.env.METRO_ELEVENLABS_URL;
let server: WebSocketServer;
let answer: (ws: WebSocket) => void = () => undefined;

beforeAll(async () => {
  server = new WebSocketServer({ port: 10_000 + Math.floor(Math.random() * 20_000), host: '127.0.0.1' });
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

test('a TTS failure after some audio is failed instead of reporting a normal finish', async () => {
  expect(await speak((ws) => {
    ws.send(JSON.stringify({ audio: Buffer.alloc(480).toString('base64') }));
    ws.close(1011, 'provider unavailable');
  })).toBe('provider unavailable');
});

test('TTS final completes once even if the socket stays open, and abort ignores late audio', async () => {
  const connected = Promise.withResolvers<WebSocket>();
  answer = (ws) => connected.resolve(ws);
  const events: string[] = [];
  const utterance = new Utterance('key', 'voice', (reason) => events.push(reason));
  utterance.attach({ audio: () => events.push('audio'), done: () => events.push('done') });
  const ws = await connected.promise;
  ws.send(JSON.stringify({ audio: Buffer.alloc(480).toString('base64'), isFinal: true }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(events).toEqual(['audio', 'done']);
  utterance.abort();
  utterance.abort();
  ws.close();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(events).toEqual(['audio', 'done']);
});

test('STT close immediately cancels even a connecting socket and never emits failure afterward', async () => {
  answer = () => undefined;
  const heard: string[] = [];
  const scribe = new Scribe('key', 'en', {
    partial: (text) => heard.push(text), committed: (text) => heard.push(text), failed: (reason) => heard.push(reason),
  });
  scribe.close();
  scribe.close();
  scribe.send(new Int16Array(1600));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(heard).toEqual([]);
});

test('STT receives committed words before cancellation and ignores queued network words afterward', async () => {
  const connected = Promise.withResolvers<WebSocket>();
  answer = (ws) => connected.resolve(ws);
  const heard: string[] = [];
  const scribe = new Scribe('key', 'en', {
    partial: (text) => heard.push(`partial ${text}`), committed: (text) => heard.push(text), failed: (reason) => heard.push(reason),
  });
  const ws = await connected.promise;
  ws.send(JSON.stringify({ message_type: 'committed_transcript', text: 'before' }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  scribe.close();
  ws.send(JSON.stringify({ message_type: 'committed_transcript', text: 'after' }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(heard).toEqual(['before']);
});
