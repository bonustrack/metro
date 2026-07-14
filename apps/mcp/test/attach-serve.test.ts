import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
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

const CACHE_NAME = 'msg_abc123_0.png';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let server: Server;
let base: string;
let attachDir: string;
const prevEnv = {
  dir: process.env.METRO_XMTP_ATTACH_DIR,
  token: process.env.METRO_MCP_HTTP_TOKEN,
  publicUrl: process.env.METRO_PUBLIC_URL,
};

beforeAll(async () => {
  attachDir = mkdtempSync(join(tmpdir(), 'metro-attach-'));
  writeFileSync(join(attachDir, CACHE_NAME), PNG);
  process.env.METRO_XMTP_ATTACH_DIR = attachDir;
  process.env.METRO_MCP_HTTP_TOKEN = 'secret-token';
  process.env.METRO_PUBLIC_URL = 'https://mcp.metro.box/';
  process.env.METRO_WEBHOOK_PORT = String(
    20000 + Math.floor(Math.random() * 20000),
  );
  process.env.METRO_HTTP_HOST = '127.0.0.1';
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
  restore('METRO_MCP_HTTP_TOKEN', prevEnv.token);
  restore('METRO_PUBLIC_URL', prevEnv.publicUrl);
});

describe('attachment url helpers', () => {
  test('publicBaseUrl trims trailing slash from METRO_PUBLIC_URL', () => {
    expect(publicBaseUrl()).toBe('https://mcp.metro.box');
  });

  test('attachmentUrl builds a token-gated url for a valid cache name', () => {
    expect(attachmentUrl(`/data/.cache/metro/messenger-uploads/${CACHE_NAME}`)).toBe(
      'https://mcp.metro.box/attach/msg_abc123_0.png?token=secret-token',
    );
  });

  test('attachmentUrl rejects paths outside the cache-name shape', () => {
    expect(attachmentUrl('/etc/passwd')).toBeNull();
    expect(attachmentUrl('../../secret.png')).toBeNull();
  });

  test('attachmentEventUrl only enriches attachmentSaved without a url', () => {
    expect(
      attachmentEventUrl({
        contentType: 'attachmentSaved',
        localPath: `/data/x/${CACHE_NAME}`,
      }),
    ).toBe('https://mcp.metro.box/attach/msg_abc123_0.png?token=secret-token');
    expect(
      attachmentEventUrl({
        contentType: 'attachmentSaved',
        localPath: `/data/x/${CACHE_NAME}`,
        url: 'https://cdn.discord/x.png',
      }),
    ).toBeNull();
    expect(attachmentEventUrl({ contentType: 'inbound' })).toBeNull();
  });
});

describe('/attach route', () => {
  test('serves a saved attachment with a valid token', async () => {
    const res = await fetch(
      `${base}/attach/${CACHE_NAME}?token=secret-token`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(PNG)).toBe(true);
  });

  test('rejects a missing or wrong token with 401', async () => {
    expect((await fetch(`${base}/attach/${CACHE_NAME}`)).status).toBe(401);
    expect(
      (await fetch(`${base}/attach/${CACHE_NAME}?token=nope`)).status,
    ).toBe(401);
  });

  test('404s an unknown attachment name', async () => {
    const res = await fetch(
      `${base}/attach/msg_missing_9.png?token=secret-token`,
    );
    expect(res.status).toBe(404);
  });

  test('ignores path-traversal names', async () => {
    const res = await fetch(
      `${base}/attach/..%2F..%2Fetc%2Fpasswd?token=secret-token`,
    );
    expect([400, 404]).toContain(res.status);
  });
});
