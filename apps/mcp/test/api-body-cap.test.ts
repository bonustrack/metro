import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createServer, request as httpRequest } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ApiError } from '../src/daemon/api-error.ts';
import { readJsonBody } from '../src/daemon/api-http.ts';

let server: Server;
let port = 0;

const isApiError = (e: unknown): e is ApiError => e instanceof ApiError;

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'GET') {
      res.writeHead(200).end('{"probe":true}');
      return;
    }
    readJsonBody(req)
      .then((body) => {
        res.writeHead(201).end(JSON.stringify(body));
      })
      .catch((err: unknown) => {
        res.writeHead(isApiError(err) ? err.status : 500).end('{}');
      });
  });
  await new Promise<void>((r) => {
    server.listen(0, '127.0.0.1', r);
  });
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((r) => {
    server.close(() => {
      r();
    });
  });
});

interface Sent {
  status: number;
  body: string;
}

const send = (body: string | null, chunked: boolean, agent = false): Promise<Sent> =>
  new Promise((resolve, reject) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (body !== null && !chunked)
      headers['content-length'] = String(Buffer.byteLength(body));
    const req = httpRequest(
      {
        port,
        host: '127.0.0.1',
        method: body === null ? 'GET' : 'POST',
        path: '/',
        headers,
        agent: agent ? undefined : false,
      },
      (res) => {
        let out = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => {
          out += c;
        });
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body: out });
        });
      },
    );
    req.on('error', reject);
    if (body === null) req.end();
    else if (!chunked) req.end(body);
    else {
      for (let i = 0; i < body.length; i += 512)
        req.write(body.slice(i, i + 512));
      req.end();
    }
  });

const oversized = JSON.stringify({ value: `Bearer ${'x'.repeat(5000)}` });

describe('the 4 KiB API body cap', () => {
  test('a body under the cap is parsed', async () => {
    const res = await send(JSON.stringify({ name: 'small' }), false);
    expect(res.status).toBe(201);
    expect(JSON.parse(res.body)).toEqual({ name: 'small' });
  });

  test('an oversized body is 413, sent in one shot', async () => {
    expect((await send(oversized, false)).status).toBe(413);
  });

  test('an oversized body is 413 when it arrives in chunks', async () => {
    expect((await send(oversized, true)).status).toBe(413);
  });

  test('the request after a 413 gets its own response — the cap drains, it does not desync', async () => {
    expect((await send(oversized, true, true)).status).toBe(413);
    const after = await send(null, false, true);
    expect(after.status).toBe(200);
    expect(after.body).toBe('{"probe":true}');
  });

  test('a 413 never yields a parsed body to the route', async () => {
    const res = await send(oversized, true);
    expect(res.body).toBe('{}');
  });
});
