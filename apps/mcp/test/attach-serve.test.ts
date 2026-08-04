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
import { setAgentMap } from '../src/db/agent-map.ts';
import { setKeyMap } from '../src/db/key-map.ts';

const CACHE_NAME = 'msg_abc123_0.png';
const OTHER_NAME = 'msg_def456_0.png';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ONE = 'mk_agent_one';
const TWO = 'mk_agent_two';

let server: Server;
let base: string;
let attachDir: string;
const prevEnv = {
  dir: process.env.METRO_XMTP_ATTACH_DIR,
  publicUrl: process.env.METRO_PUBLIC_URL,
};

beforeAll(async () => {
  attachDir = mkdtempSync(join(tmpdir(), 'metro-attach-'));
  writeFileSync(join(attachDir, CACHE_NAME), PNG);
  writeFileSync(join(attachDir, OTHER_NAME), PNG);
  process.env.METRO_XMTP_ATTACH_DIR = attachDir;
  process.env.METRO_PUBLIC_URL = 'https://mcp.metro.box/';
  process.env.METRO_WEBHOOK_PORT = String(
    20000 + Math.floor(Math.random() * 20000),
  );
  process.env.METRO_HTTP_HOST = '127.0.0.1';
  setKeyMap([
    { key: ONE, agentId: 1 },
    { key: TWO, agentId: 2 },
  ]);
  setAgentMap({ 'xmtp/x1': 1, 'telegram/t2': 2 }, { 1: 'tony', 2: 'lisa' });
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

  test('attachmentUrl carries the owning agent key and records the owner', () => {
    expect(
      attachmentUrl(`/data/.cache/metro/messenger-uploads/${CACHE_NAME}`, 1),
    ).toBe(`https://mcp.metro.box/attach/${CACHE_NAME}?token=${ONE}`);
    expect(attachmentOwner(CACHE_NAME)).toBe(1);
    expect(existsSync(join(attachDir, `${CACHE_NAME}.owner`))).toBe(true);
  });

  test('an agent with no key gets no url and no owner record', () => {
    expect(attachmentUrl(`/data/x/${OTHER_NAME}`, 99)).toBeNull();
    expect(attachmentOwner(OTHER_NAME)).toBeUndefined();
  });

  test('attachmentUrl rejects paths outside the cache-name shape', () => {
    expect(attachmentUrl('/etc/passwd', 1)).toBeNull();
    expect(attachmentUrl('../../secret.png', 1)).toBeNull();
  });

  test('attachmentEventUrl only enriches attachmentSaved without a url', () => {
    expect(
      attachmentEventUrl(
        { contentType: 'attachmentSaved', localPath: `/data/x/${CACHE_NAME}` },
        1,
      ),
    ).toBe(`https://mcp.metro.box/attach/${CACHE_NAME}?token=${ONE}`);
    expect(
      attachmentEventUrl(
        {
          contentType: 'attachmentSaved',
          localPath: `/data/x/${CACHE_NAME}`,
          url: 'https://cdn.discord/x.png',
        },
        1,
      ),
    ).toBeNull();
    expect(attachmentEventUrl({ contentType: 'inbound' }, 1)).toBeNull();
  });
});

describe('/attach route', () => {
  test('serves a saved attachment to the agent that owns it', async () => {
    attachmentUrl(CACHE_NAME, 1);
    const res = await fetch(`${base}/attach/${CACHE_NAME}?token=${ONE}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(PNG)).toBe(true);
  });

  test('the Bearer header works as well as ?token=', async () => {
    attachmentUrl(CACHE_NAME, 1);
    const res = await fetch(`${base}/attach/${CACHE_NAME}`, {
      headers: { authorization: `Bearer ${ONE}` },
    });
    expect(res.status).toBe(200);
  });

  test('another agent key cannot fetch it even knowing the name', async () => {
    attachmentUrl(CACHE_NAME, 1);
    const res = await fetch(`${base}/attach/${CACHE_NAME}?token=${TWO}`);
    expect(res.status).toBe(401);
  });

  test('rejects a missing or unknown token with 401', async () => {
    expect((await fetch(`${base}/attach/${CACHE_NAME}`)).status).toBe(401);
    expect(
      (await fetch(`${base}/attach/${CACHE_NAME}?token=nope`)).status,
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
});
