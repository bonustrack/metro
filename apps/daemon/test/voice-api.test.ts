import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleVoiceRequest } from '../src/voice/api.ts';
import { brainModel, languageOf, parseVoice } from '../src/voice/store.ts';
import { sttUrl } from '../src/voice/scribe.ts';
import { auth } from './identity-helper.ts';

const OWNER = 'org_01VOICETEST000000000';
const saved = process.env.METRO_AGENTS_DIR;
let dir = '';
let server: Server;
let base = '';

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'metro-voice-'));
  process.env.METRO_AGENTS_DIR = dir;
  server = createServer((req, res) => {
    if (handleVoiceRequest(req, res)) return;
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => {
    server.listen(0, '127.0.0.1', r);
  });
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  if (saved === undefined) delete process.env.METRO_AGENTS_DIR;
  else process.env.METRO_AGENTS_DIR = saved;
  await new Promise<void>((r) => {
    server.close(() => {
      r();
    });
  });
});

const call = async (method: string, role: 'admin' | 'member' | null, body?: unknown): Promise<Response> =>
  fetch(`${base}/api/voice`, {
    method,
    headers: { ...(role === null ? {} : { authorization: await auth(OWNER, role) }), 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe('the voice settings of a box', () => {
  test('keep the key on the daemon and never answer it', async () => {
    expect((await call('GET', null)).status).toBe(401);
    expect((await call('DELETE', null)).status).toBe(405);
    expect((await call('PUT', 'member', { apiKey: 'sk-SECRET' })).status).toBe(403);
    const put = await call('PUT', 'admin', { provider: 'elevenlabs', apiKey: 'sk-SECRET', voiceId: 'v1', model: 'codex:gpt-6' });
    expect(put.status).toBe(200);
    const text = await put.text();
    expect(text).not.toContain('sk-SECRET');
    expect(JSON.parse(text)).toMatchObject({ provider: 'elevenlabs', hasKey: true, voiceId: 'v1', model: 'codex:gpt-6', enabled: true });
    expect(readFileSync(join(dir, 'voice.json'), 'utf8')).toContain('sk-SECRET');
    expect(statSync(join(dir, 'voice.json')).mode & 0o777).toBe(0o600);
    const kept = await (await call('PUT', 'admin', { voiceId: 'v2', apiKey: '', enabled: false })).json();
    expect(kept).toMatchObject({ hasKey: true, voiceId: 'v2', enabled: false });
    expect((await call('PUT', 'admin', { provider: 'nope' })).status).toBe(400);
    expect(await (await call('PUT', 'admin', { apiKey: null })).json()).toMatchObject({ hasKey: false });
    expect(await (await call('GET', 'member')).json()).toMatchObject({ hasKey: false, voiceId: 'v2' });
  });

  test('call Claude through the Anthropic connection when there is one, else the plain model', () => {
    const cfg = parseVoice({ apiKey: 'k' });
    const none = { version: 2 as const, route: '', connections: [] };
    expect(brainModel(cfg, none)).toBe('claude-sonnet-5-5');
    const anthropic = { ...none, connections: [{ provider: 'anthropic' }] } as unknown as Parameters<typeof brainModel>[1];
    expect(brainModel(cfg, anthropic)).toBe('anthropic:claude-sonnet-5-5');
    expect(brainModel(parseVoice({ model: 'codex:gpt-6' }), none)).toBe('codex:gpt-6');
  });

  test('speech to text listens in English unless the page picks another language or Detect', async () => {
    expect(languageOf(parseVoice({}))).toBe('en');
    expect(sttUrl('en')).toContain('language_code=en');
    expect(sttUrl(null)).not.toContain('language_code');
    expect(await (await call('PUT', 'admin', { language: 'FR' })).json()).toMatchObject({ language: 'fr', defaults: { language: 'en' } });
    expect(languageOf(parseVoice(JSON.parse(readFileSync(join(dir, 'voice.json'), 'utf8'))))).toBe('fr');
    expect((await call('PUT', 'admin', { language: 'french' })).status).toBe(400);
    expect(await (await call('PUT', 'admin', { language: 'auto' })).json()).toMatchObject({ language: 'auto' });
    expect(languageOf(parseVoice({ language: 'auto' }))).toBeNull();
  });
});
