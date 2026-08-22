/**
 * Discord inbound attachments.
 *
 * Two things are pinned here.
 *
 * 1. The `attachmentSaved` payload carries NO station url. It used to carry
 *    `ref.url`, the Discord CDN link, which expires in 24 hours AND made
 *    `attachmentEventUrl` (daemon/attach-serve.ts) skip minting a grant — so
 *    no `.owner` sidecar was written and our own `GET /attach/<file>?token=`
 *    answered 401 for discord files while answering 200 for every other
 *    station's. With no url on the payload the daemon mints the grant, exactly
 *    as it does for telegram, telegram-user and xmtp.
 *
 * 2. A voice note reads as a voice note. Discord marks one with the message
 *    flag `IsVoiceMessage` (8192) and ships it as an ordinary `audio/ogg`
 *    attachment named `voice-message.ogg`, so a tag built from `contentType`
 *    alone could not tell it apart from an mp3 someone uploaded.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message } from 'discord.js';
import { messageEnvelope } from '../src/format.ts';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CDN =
  'https://cdn.discordapp.com/attachments/1504226489359401221/1534630426348486886/exploding-kittens-bot.html?ex=6a74d375&is=6a7381f5';

const realFetch = globalThis.fetch;
const realWrite = process.stdout.write.bind(process.stdout);
const prevDir = process.env.METRO_XMTP_ATTACH_DIR;
let lines: string[] = [];

interface Att {
  id: string;
  url: string;
  proxyURL: string;
  name: string;
  contentType: string;
  size: number;
}

const collection = <T,>(items: T[]): { map: <R>(f: (v: T) => R) => R[]; values: () => IterableIterator<T> } => ({
  map: (f) => items.map(f),
  values: () => items.values(),
});

const fakeMessage = (attachments: Att[], flags: number): Message =>
  ({
    author: { bot: false, id: '238307675501232128', username: 'bonustrack_', globalName: 'less' },
    attachments: collection(attachments),
    stickers: collection([]),
    content: 'Great caption here',
    channelId: '1504226489359401221',
    channel: { name: 'general' },
    createdTimestamp: 1_785_954_805_698,
    guildId: null,
    id: '1534630426356879492',
    reference: null,
    flags: { has: (bit: number) => (flags & bit) !== 0 },
    toJSON: () => ({ flags }),
  }) as unknown as Message;

const htmlAttachment: Att = {
  id: '1534630426348486886',
  url: CDN,
  proxyURL: CDN,
  name: 'exploding-kittens-bot.html',
  contentType: 'text/html',
  size: 8,
};

const waitForAttachmentSaved = async (): Promise<
  Record<string, unknown> | undefined
> => {
  for (let waited = 0; waited < 5000; waited += 25) {
    const found = emittedAttachmentSaved();
    if (found !== undefined) return found;
    await Bun.sleep(25);
  }
  return emittedAttachmentSaved();
};

const emittedAttachmentSaved = (): Record<string, unknown> | undefined => {
  for (const line of lines) {
    const parsed = JSON.parse(line) as {
      payload?: { contentType?: string };
    };
    if (parsed.payload?.contentType === 'attachmentSaved')
      return parsed as Record<string, unknown>;
  }
  return undefined;
};

beforeAll(() => {
  process.env.METRO_XMTP_ATTACH_DIR = mkdtempSync(
    join(tmpdir(), 'metro-discord-att-'),
  );
  globalThis.fetch = (() =>
    Promise.resolve(new Response(PNG, { status: 200 }))) as typeof fetch;
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    if (typeof chunk === 'string') lines.push(...chunk.trim().split('\n'));
    return true;
  }) as typeof process.stdout.write;
});

afterEach(() => {
  lines = [];
});

afterAll(() => {
  globalThis.fetch = realFetch;
  process.stdout.write = realWrite;
  if (prevDir === undefined) delete process.env.METRO_XMTP_ATTACH_DIR;
  else process.env.METRO_XMTP_ATTACH_DIR = prevDir;
});

describe('discord attachmentSaved payload', () => {
  test('carries the cached path and no expiring station url', async () => {
    messageEnvelope('d0', fakeMessage([htmlAttachment], 0));

    const saved = await waitForAttachmentSaved();
    expect(saved).toBeDefined();
    const payload = saved?.payload as Record<string, unknown>;
    expect(payload.attachmentFor).toBeString();
    expect(payload.name).toBe('exploding-kittens-bot.html');
    expect(payload.mime).toBe('text/html');
    expect(String(payload.attachmentPath)).toContain('msg_1534630426356879_0');
    expect(payload.url).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain('cdn.discordapp.com');
  });
});

describe('discord voice notes', () => {
  const voiceAttachment: Att = {
    id: '1534629935715455126',
    url: 'https://cdn.discordapp.com/attachments/1/2/voice-message.ogg',
    proxyURL: 'https://cdn.discordapp.com/attachments/1/2/voice-message.ogg',
    name: 'voice-message.ogg',
    contentType: 'audio/ogg',
    size: 8,
  };

  test('a message flagged IsVoiceMessage reads as a voice note', async () => {
    const env = messageEnvelope('d0', fakeMessage([voiceAttachment], 8192));
    expect(env?.text).toBe('Great caption here [voice]');
    await Bun.sleep(50);
  });

  test('an ordinary audio upload is still an audio file', async () => {
    const mp3: Att = {
      ...voiceAttachment,
      name: 'Aya_Nakamura_-_SMS.mp3',
      contentType: 'audio/mpeg',
    };
    const env = messageEnvelope('d0', fakeMessage([mp3], 0));
    expect(env?.text).toBe('Great caption here [audio: Aya_Nakamura_-_SMS.mp3]');
    await Bun.sleep(50);
  });
});
