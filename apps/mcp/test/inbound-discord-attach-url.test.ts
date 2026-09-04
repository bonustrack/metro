/**
 * A discord-bot attachment gets a metro grant like every other station's.
 *
 * `attachmentEventUrl` mints a per-attachment grant only for an
 * `attachmentSaved` payload that carries NO url of its own. The discord-bot train
 * used to set `url: ref.url` — the Discord CDN link — so no grant was minted,
 * no `.owner` sidecar was written, the advertised link expired after 24 hours,
 * and our own `GET /attach/<file>?token=<agent key>` answered 401 for discord-bot
 * files while answering 200 for telegram-bot, telegram and xmtp.
 *
 * The station stopped emitting that url (packages/discord-bot/src/format.ts). Here
 * we drive the daemon's emit path with both payload shapes and show the
 * difference end to end, over real HTTP.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { makeEmit, startWebhookServer } from '../src/daemon/http.ts';
import { subscribeEvents, type MetroEvent } from '../src/daemon/events.ts';
import { attachmentOwner } from '../src/daemon/attach-owner.ts';
import { readAttachmentGrant } from '../src/daemon/attach-grant.ts';
import { setAgentMap } from '../src/db/agent-map.ts';
import { setKeyMap } from '../src/db/key-map.ts';

const AGENT_KEY = 'mk_discord_owner';
const FIXED = 'msg_1534630426356879_0.html';
const CDN_ONLY = 'msg_1534630426356880_0.html';
const LINE = 'metro://discord-bot/d0/1504226489359401221';
const BODY = Buffer.from('<html>hi</html>');

let server: Server;
let base: string;
let attachDir: string;
const prevEnv = {
  dir: process.env.METRO_XMTP_ATTACH_DIR,
  publicUrl: process.env.METRO_PUBLIC_URL,
};

const savedEvent = (
  name: string,
  extra: Record<string, unknown> = {},
): MetroEvent =>
  ({
    id: `ev_${name}`,
    ts: new Date().toISOString(),
    station: 'discord-bot',
    line: LINE,
    from: 'metro://user',
    to: LINE,
    text: `📎 saved: /data/x/${name}`,
    payload: {
      account: 'd0',
      contentType: 'attachmentSaved',
      attachmentFor: 'msg_a8rbc9lk',
      index: 0,
      attachmentPath: `/data/.cache/metro/messenger-uploads/${name}`,
      localPath: `/data/.cache/metro/messenger-uploads/${name}`,
      mime: 'text/html',
      name: 'exploding-kittens-bot.html',
      ...extra,
    },
  }) as unknown as MetroEvent;

function emitAndCapture(entry: MetroEvent): MetroEvent {
  const seen: MetroEvent[] = [];
  const off = subscribeEvents((e) => seen.push(e));
  makeEmit()(entry);
  off();
  const out = seen[seen.length - 1];
  if (!out) throw new Error('event never reached the bus');
  return out;
}

beforeAll(async () => {
  attachDir = mkdtempSync(join(tmpdir(), 'metro-discord-bot-url-'));
  for (const name of [FIXED, CDN_ONLY]) writeFileSync(join(attachDir, name), BODY);
  process.env.METRO_XMTP_ATTACH_DIR = attachDir;
  process.env.METRO_PUBLIC_URL = 'https://api.metro.box';
  process.env.METRO_WEBHOOK_PORT = String(
    10000 + Math.floor(Math.random() * 20000),
  );
  process.env.METRO_HTTP_HOST = '127.0.0.1';
  setKeyMap([{ key: AGENT_KEY, agentId: 'agent000007' }]);
  setAgentMap({ 'discord-bot/d0': 'agent000007' }, { ['agent000007']: 'tony' });
  server = await startWebhookServer(makeEmit());
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (prevEnv.dir === undefined) delete process.env.METRO_XMTP_ATTACH_DIR;
  else process.env.METRO_XMTP_ATTACH_DIR = prevEnv.dir;
  if (prevEnv.publicUrl === undefined) delete process.env.METRO_PUBLIC_URL;
  else process.env.METRO_PUBLIC_URL = prevEnv.publicUrl;
  setKeyMap([]);
  setAgentMap({}, {});
});

describe('a discord-bot attachmentSaved event with no station url', () => {
  test('is enriched with a metro url and an owner sidecar', () => {
    const out = emitAndCapture(savedEvent(FIXED));
    const url = String((out.payload as { url?: string }).url);
    expect(url).toStartWith(`https://api.metro.box/attach/${FIXED}?token=at_`);
    expect(attachmentOwner(FIXED)).toBe('agent000007');
    expect(existsSync(join(attachDir, `${FIXED}.owner`))).toBe(true);
    expect(existsSync(join(attachDir, `${FIXED}.grant`))).toBe(true);
  });

  test('the advertised url serves the file, and the owning key does too', async () => {
    emitAndCapture(savedEvent(FIXED));
    const token = readAttachmentGrant(FIXED)?.token ?? '';
    const byGrant = await fetch(`${base}/attach/${FIXED}?token=${token}`);
    expect(byGrant.status).toBe(200);
    expect(Buffer.from(await byGrant.arrayBuffer()).equals(BODY)).toBe(true);
    const byKey = await fetch(`${base}/attach/${FIXED}?token=${AGENT_KEY}`);
    expect(byKey.status).toBe(200);
  });
});

describe('the shape that caused the bug', () => {
  test('a payload carrying a cdn url gets no grant and 401s', async () => {
    const out = emitAndCapture(
      savedEvent(CDN_ONLY, {
        url: 'https://cdn.discordapp.com/attachments/1/2/x.html?ex=6a74d375',
      }),
    );
    expect(String((out.payload as { url?: string }).url)).toStartWith(
      'https://cdn.discordapp.com/',
    );
    expect(attachmentOwner(CDN_ONLY)).toBeUndefined();
    expect(existsSync(join(attachDir, `${CDN_ONLY}.grant`))).toBe(false);
    const res = await fetch(`${base}/attach/${CDN_ONLY}?token=${AGENT_KEY}`);
    expect(res.status).toBe(401);
  });
});
