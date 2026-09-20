import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { listRemoteTools } from '../src/connectors/tools.ts';
import { allowLocalConnectors, ConnectorVerifyError } from '../src/connectors/url.ts';

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
  allowLocalConnectors(true);
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
  allowLocalConnectors(false);
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
      { name: 'Search', description: 'Finds things', readOnly: true },
      { name: 'delete_thing', description: '', readOnly: false },
      { name: 'page_two', description: '', readOnly: false },
    ]);
    expect(seen.map((s) => s.rpc || s.method)).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'tools/list', 'DELETE']);
    for (const frame of seen.slice(1)) {
      expect(frame.headers['mcp-session-id']).toBe('sess-1');
      expect(frame.headers['mcp-protocol-version']).toBe('2025-06-18');
    }
    for (const frame of seen) expect(frame.headers.authorization).toBe('Bearer v1');
  });

  test('a refused credential and a dead server are refusals the page can show', async () => {
    status = 401;
    await expect(listRemoteTools(new URL(`${origin}/mcp`), { kind: 'none' })).rejects.toBeInstanceOf(ConnectorVerifyError);
    await expect(listRemoteTools(new URL(`${origin}/mcp`), { kind: 'none' })).rejects.toThrow(/rejected the credential/);
    await expect(listRemoteTools(new URL('http://127.0.0.1:9/mcp'), { kind: 'none' })).rejects.toThrow(/could not reach/);
  });
});
