import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { makeEmit, startWebhookServer } from '../src/daemon/http.ts';
import {
  attachmentEventUrl,
  attachmentUrl,
  publicBaseUrl,
} from '../src/daemon/attach-serve.ts';
import { attachmentOwner } from '../src/daemon/attach-owner.ts';
import { readAttachmentGrant } from '../src/daemon/attach-grant.ts';
import { setAgentMap } from '../src/db/agent-map.ts';
import { setKeyMap } from '../src/db/key-map.ts';

const CACHE_NAME = 'msg_abc123_0.png';
const OTHER_NAME = 'msg_def456_0.png';
const THIRD_NAME = 'msg_ghi789_0.png';
const KEYLESS_NAME = 'msg_jkl012_0.png';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ONE = 'mk_agent_one';
const TWO = 'mk_agent_two';

const tokenOf = (url: string | null): string =>
  new URL(url ?? 'http://x/').searchParams.get('token') ?? '';

let server: Server;
let base: string;
let attachDir: string;
const prevEnv = {
  dir: process.env.METRO_XMTP_ATTACH_DIR,
  publicUrl: process.env.METRO_PUBLIC_URL,
};

beforeAll(async () => {
  attachDir = mkdtempSync(join(tmpdir(), 'metro-attach-'));
  for (const name of [CACHE_NAME, OTHER_NAME, THIRD_NAME, KEYLESS_NAME])
    writeFileSync(join(attachDir, name), PNG);
  process.env.METRO_XMTP_ATTACH_DIR = attachDir;
  process.env.METRO_PUBLIC_URL = 'https://mcp.metro.box/';
  process.env.METRO_WEBHOOK_PORT = String(
    20000 + Math.floor(Math.random() * 20000),
  );
  process.env.METRO_HTTP_HOST = '127.0.0.1';
  setKeyMap([
    { key: ONE, agentId: 'agent000001' },
    { key: TWO, agentId: 'agent000002' },
  ]);
  setAgentMap({ 'xmtp/x1': 'agent000001', 'telegram-bot/t2': 'agent000002' }, { ['agent000001']: 'tony', ['agent000002']: 'lisa' });
  server = await startWebhookServer(makeEmit());
  const addr = server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  restore('METRO_XMTP_ATTACH_DIR', prevEnv.dir);
  restore('METRO_PUBLIC_URL', prevEnv.publicUrl);
  setKeyMap([]);
  setAgentMap({}, {});
});

describe('attachment url helpers', () => {
  test('publicBaseUrl trims trailing slash from METRO_PUBLIC_URL', () => {
    expect(publicBaseUrl()).toBe('https://mcp.metro.box');
  });

  test('attachmentUrl records the owner and mints a per-attachment token', () => {
    const url = attachmentUrl(
      `/data/.cache/metro/messenger-uploads/${CACHE_NAME}`,
      'agent000001',
    );
    expect(url).toStartWith(`https://mcp.metro.box/attach/${CACHE_NAME}?token=`);
    expect(attachmentOwner(CACHE_NAME)).toBe('agent000001');
    expect(existsSync(join(attachDir, `${CACHE_NAME}.owner`))).toBe(true);
    expect(existsSync(join(attachDir, `${CACHE_NAME}.grant`))).toBe(true);
    expect(readAttachmentGrant(CACHE_NAME)?.agentId).toBe('agent000001');
  });

  test('the url never carries the owning agent api key', () => {
    const url = attachmentUrl(CACHE_NAME, 'agent000001') ?? '';
    expect(url).not.toContain(ONE);
    expect(url).not.toContain(TWO);
    expect(tokenOf(url)).toStartWith('at_');
  });

  test('re-minting the same attachment for the same owner keeps one token', () => {
    const first = attachmentUrl(THIRD_NAME, 'agent000001');
    const second = attachmentUrl(THIRD_NAME, 'agent000001');
    expect(second).toBe(first);
  });

  test('two attachments never share a token', () => {
    expect(tokenOf(attachmentUrl(CACHE_NAME, 'agent000001'))).not.toBe(
      tokenOf(attachmentUrl(THIRD_NAME, 'agent000001')),
    );
  });

  test('an agent with no api key still gets a working attachment url', async () => {
    const url = attachmentUrl(KEYLESS_NAME, 'agent000099');
    expect(url).not.toBeNull();
    expect(attachmentOwner(KEYLESS_NAME)).toBe('agent000099');
    const res = await fetch(
      `${base}/attach/${KEYLESS_NAME}?token=${tokenOf(url)}`,
    );
    expect(res.status).toBe(200);
  });

  test('attachmentUrl rejects paths outside the cache-name shape', () => {
    expect(attachmentUrl('/etc/passwd', 'agent000001')).toBeNull();
    expect(attachmentUrl('../../secret.png', 'agent000001')).toBeNull();
  });

  test('attachmentEventUrl only enriches attachmentSaved without a url', () => {
    expect(
      attachmentEventUrl(
        { contentType: 'attachmentSaved', localPath: `/data/x/${CACHE_NAME}` },
        1,
      ),
    ).toStartWith(`https://mcp.metro.box/attach/${CACHE_NAME}?token=at_`);
    expect(
      attachmentEventUrl(
        {
          contentType: 'attachmentSaved',
          localPath: `/data/x/${CACHE_NAME}`,
          url: 'https://cdn.example/x.png',
        },
        1,
      ),
    ).toBeNull();
    expect(attachmentEventUrl({ contentType: 'inbound' }, 'agent000001')).toBeNull();
  });
});

describe('/attach route', () => {
  test('serves a saved attachment to the holder of its own token', async () => {
    const url = attachmentUrl(CACHE_NAME, 'agent000001');
    const res = await fetch(`${base}/attach/${CACHE_NAME}?token=${tokenOf(url)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(PNG)).toBe(true);
  });

  test('the attachment token works as a Bearer header too', async () => {
    const url = attachmentUrl(CACHE_NAME, 'agent000001');
    const res = await fetch(`${base}/attach/${CACHE_NAME}`, {
      headers: { authorization: `Bearer ${tokenOf(url)}` },
    });
    expect(res.status).toBe(200);
  });

  test('one attachment token does not open another attachment', async () => {
    attachmentUrl(CACHE_NAME, 'agent000001');
    const other = attachmentUrl(THIRD_NAME, 'agent000001');
    const res = await fetch(
      `${base}/attach/${CACHE_NAME}?token=${tokenOf(other)}`,
    );
    expect(res.status).toBe(401);
  });

  test('the owning agent key still serves its own attachment', async () => {
    attachmentUrl(CACHE_NAME, 'agent000001');
    expect((await fetch(`${base}/attach/${CACHE_NAME}?token=${ONE}`)).status).toBe(
      200,
    );
  });

  test('another agent key cannot fetch it even knowing the name', async () => {
    attachmentUrl(CACHE_NAME, 'agent000001');
    const res = await fetch(`${base}/attach/${CACHE_NAME}?token=${TWO}`);
    expect(res.status).toBe(401);
  });

  test('rejects a missing or unknown token with 401', async () => {
    expect((await fetch(`${base}/attach/${CACHE_NAME}`)).status).toBe(401);
    expect(
      (await fetch(`${base}/attach/${CACHE_NAME}?token=nope`)).status,
    ).toBe(401);
    expect(
      (await fetch(`${base}/attach/${CACHE_NAME}?token=at_not_a_real_grant`))
        .status,
    ).toBe(401);
  });

  test('an attachment with no recorded owner is refused, not served', async () => {
    const res = await fetch(`${base}/attach/${OTHER_NAME}?token=${ONE}`);
    expect(res.status).toBe(401);
  });

  test('401s an unknown attachment name', async () => {
    const res = await fetch(`${base}/attach/msg_missing_9.png?token=${ONE}`);
    expect(res.status).toBe(401);
  });

  test('ignores path-traversal names', async () => {
    const res = await fetch(
      `${base}/attach/..%2F..%2Fetc%2Fpasswd?token=${ONE}`,
    );
    expect([400, 401, 404]).toContain(res.status);
  });

  test('a name that is not a cache name at all is a 404, not a 401', async () => {
    for (const name of ['horse.mp3', 'README.md', 'msg_.png', 'msg_a_0.toolong'])
      expect(
        (await fetch(`${base}/attach/${encodeURIComponent(name)}?token=${ONE}`))
          .status,
      ).toBe(404);
  });

  test('the 404 depends on the name alone, never on what is on disk', async () => {
    const withCred = await fetch(`${base}/attach/horse.mp3?token=${ONE}`);
    const without = await fetch(`${base}/attach/horse.mp3`);
    const wrongAgent = await fetch(`${base}/attach/horse.mp3?token=${TWO}`);
    expect(withCred.status).toBe(404);
    expect(without.status).toBe(404);
    expect(wrongAgent.status).toBe(404);
  });

  test('a cache-shaped name stays a flat 401 whether or not it exists', async () => {
    attachmentUrl(CACHE_NAME, 'agent000001');
    const present = await fetch(`${base}/attach/${CACHE_NAME}?token=${TWO}`);
    const absent = await fetch(`${base}/attach/msg_nothere_0.png?token=${TWO}`);
    const anonPresent = await fetch(`${base}/attach/${CACHE_NAME}`);
    const anonAbsent = await fetch(`${base}/attach/msg_nothere_0.png`);
    expect(present.status).toBe(401);
    expect(absent.status).toBe(401);
    expect(anonPresent.status).toBe(401);
    expect(anonAbsent.status).toBe(401);
  });
});
