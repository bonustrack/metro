import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { log } from '@metro-labs/core/log';
import type { FetchLike } from '@metro-labs/core/stations/oauth';
import { ApiError } from '@metro-labs/http/api-error';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { listRemoteTools } from '../src/connectors/tools.ts';
import { ConnectorVerifyError } from '@metro-labs/http/connector-url';

interface Seen {
  method: string;
  rpc: string;
  headers: Record<string, string | string[] | undefined>;
}

let server: Server;
let origin = '';
let seen: Seen[] = [];
let pages = 1;
let status = 200;

const answer = (res: ServerResponse, id: number, result: unknown): void => {
  res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' });
  res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
};

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = chunks.length === 0 ? {} : (JSON.parse(Buffer.concat(chunks).toString('utf8')) as { method?: string; params?: { cursor?: string } });
      seen.push({ method: req.method ?? '', rpc: body.method ?? '', headers: req.headers });
      if (status !== 200) {
        res.writeHead(status).end();
        return;
      }
      if (req.method === 'DELETE') {
        res.writeHead(204).end();
        return;
      }
      if (body.method === 'initialize') answer(res, 1, { protocolVersion: '2025-06-18', serverInfo: { name: 'vendor' } });
      else if (body.method === 'notifications/initialized') res.writeHead(202).end();
      else if (body.method === 'tools/list') {
        const page = body.params?.cursor === 'p2' ? 2 : 1;
        answer(res, 2, {
          tools: page === 1 ? [{ name: 'search', title: 'Search', description: 'Finds things', annotations: { readOnlyHint: true } }, { name: 'delete_thing' }, { nope: 1 }] : [{ name: 'page_two' }],
          ...(page === 1 && pages > 1 ? { nextCursor: 'p2' } : {}),
        });
      } else res.writeHead(405).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  seen = [];
  pages = 1;
  status = 200;
});

describe('listing a connector\'s tools live', () => {
  test('opens a session, walks every page, ends the session, and reads title, description and the read-only hint', async () => {
    pages = 2;
    const tools = await listRemoteTools(new URL(`${origin}/mcp`), { kind: 'header', name: 'Authorization', value: 'Bearer v1' });
    expect(tools).toEqual([
      { name: 'search', title: 'Search', description: 'Finds things', readOnly: true },
      { name: 'delete_thing', title: 'delete_thing', description: '', readOnly: false },
      { name: 'page_two', title: 'page_two', description: '', readOnly: false },
    ]);
    expect(seen.map((s) => s.rpc || s.method)).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'tools/list', 'DELETE']);
    for (const frame of seen.slice(1)) {
      expect(frame.headers['mcp-session-id']).toBe('sess-1');
      expect(frame.headers['mcp-protocol-version']).toBe('2025-06-18');
    }
    for (const frame of seen) expect(frame.headers.authorization).toBe('Bearer v1');
  });

  test('a supplied transport supplies current headers for initialize, initialized, every page and DELETE', async () => {
    pages = 2;
    const calls: string[] = [];
    const transport: FetchLike = async (url, init) => {
      expect(url).toBe(`${origin}/mcp`);
      expect(init?.redirect).toBe('manual');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      const headers = new Headers(init?.headers);
      expect(headers.has('authorization')).toBe(false);
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as { method: string } : null;
      calls.push(body?.method ?? init?.method ?? '');
      headers.set('authorization', `Bearer current-${calls.length}`);
      return fetch(url, { ...init, headers });
    };
    expect(await listRemoteTools(new URL(`${origin}/mcp`), { kind: 'none' }, transport)).toHaveLength(3);
    expect(calls).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'tools/list', 'DELETE']);
    expect(seen.map((frame) => frame.headers.authorization)).toEqual(calls.map((_call, index) => `Bearer current-${index + 1}`));
    for (const frame of seen.slice(1)) {
      expect(frame.headers['mcp-session-id']).toBe('sess-1');
      expect(frame.headers['mcp-protocol-version']).toBe('2025-06-18');
    }
  });

  for (const stage of [1, 2, 3, 4]) {
    test(`typed transport refusal at network stage ${stage} keeps its status`, async () => {
      pages = 2;
      let calls = 0;
      const refusal = new ApiError('The organization connector is unavailable.', stage % 2 === 0 ? 503 : 424);
      const transport: FetchLike = async (url, init) => {
        calls += 1;
        if (calls === stage) throw refusal;
        return fetch(url, init);
      };
      await expect(listRemoteTools(new URL(`${origin}/mcp`), { kind: 'none' }, transport)).rejects.toBe(refusal);
      expect(calls).toBe(stage);
      expect(seen).toHaveLength(stage - 1);
    });
  }

  test('custom transport cleanup failures log neither their sensitive cause nor the target', async () => {
    const debug = spyOn(log, 'debug');
    const url = new URL(`${origin}/mcp?key=private-query`);
    const transport: FetchLike = async (target, init) => {
      if (init?.method === 'DELETE') throw new ApiError(`Bearer private-header at ${target}`, 503);
      return fetch(target, init);
    };
    try {
      expect(await listRemoteTools(url, { kind: 'none' }, transport)).toHaveLength(2);
      expect(debug.mock.calls).toHaveLength(1);
      const output = JSON.stringify(debug.mock.calls);
      for (const secret of ['private-header', 'private-query', url.hostname, url.toString()]) expect(output).not.toContain(secret);
    } finally {
      debug.mockRestore();
    }
  });

  test('a refused credential and a dead server are refusals the page can show', async () => {
    status = 401;
    await expect(listRemoteTools(new URL(`${origin}/mcp`), { kind: 'none' })).rejects.toBeInstanceOf(ConnectorVerifyError);
    await expect(listRemoteTools(new URL(`${origin}/mcp`), { kind: 'none' })).rejects.toThrow(/rejected the credential/);
    await expect(listRemoteTools(new URL('http://127.0.0.1:9/mcp'), { kind: 'none' })).rejects.toThrow(/could not reach/);
  });
});
