import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { bootDaemon, type Daemon } from './http-harness.ts';

let daemon: Daemon;
let base: string;

beforeAll(async () => {
  const mode = (): { mode: 'hosted'; owner: null; project: null } => ({
    mode: 'hosted',
    owner: null,
    project: null,
  });
  daemon = await bootDaemon({ mode }, {
    mcp: async (_req, res) => {
      res.writeHead(200).end('ok');
    },
  });
  base = daemon.base;
});

afterAll(async () => {
  await daemon.close();
});

describe('MCP CORS (browser cross-origin from the accounts UI)', () => {
  test('preflight from metro.box returns 204 with CORS headers', async () => {
    const res = await fetch(`${base}/`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://metro.box',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type,mcp-session-id',
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(
      'https://metro.box',
    );
    const allow = res.headers.get('access-control-allow-headers') ?? '';
    expect(allow.toLowerCase()).toContain('content-type');
    expect(allow.toLowerCase()).toContain('mcp-session-id');
    expect(
      (res.headers.get('access-control-expose-headers') ?? '').toLowerCase(),
    ).toContain('mcp-session-id');
    await res.text();
  });

  test('an API preflight from metro.box is allowed to reach a private-network daemon', async () => {
    const res = await fetch(`${base}/api/mode`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://metro.box',
        'access-control-request-method': 'GET',
        'access-control-request-private-network': 'true',
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-private-network')).toBe('true');
    expect(res.headers.get('access-control-allow-origin')).toBe('https://metro.box');
    await res.text();
  });

  test('POST from metro.box reaches the handler with CORS header', async () => {
    const res = await fetch(`${base}/`, {
      method: 'POST',
      headers: { origin: 'https://metro.box', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe(
      'https://metro.box',
    );
    await res.text();
  });

  test('an arbitrary foreign origin is reflected', async () => {
    const origin = 'https://deploy-preview-107--metro-ui.netlify.app';
    const res = await fetch(`${base}/`, {
      method: 'OPTIONS',
      headers: {
        origin,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type',
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(origin);
    const allow = res.headers.get('access-control-allow-headers') ?? '';
    expect(allow.toLowerCase()).toContain('authorization');
    await res.text();
  });

  test('a localhost dev origin is reflected', async () => {
    const res = await fetch(`${base}/mcp`, {
      method: 'OPTIONS',
      headers: {
        origin: 'http://localhost:5175',
        'access-control-request-method': 'POST',
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(
      'http://localhost:5175',
    );
    await res.text();
  });

  test('a request with no Origin falls back to *', async () => {
    const res = await fetch(`${base}/`, {
      method: 'OPTIONS',
      headers: { 'access-control-request-method': 'POST' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    await res.text();
  });
});
