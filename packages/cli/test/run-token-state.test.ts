import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { runTokenState } from '../src/runtime.ts';

const KEEP = process.env.METRO_URL;
let server: Server;

beforeAll(async () => {
  server = createServer((req, res) => {
    const auth = req.headers.authorization ?? '';
    const status = auth === 'Bearer live' ? 200 : auth === 'Bearer stale' ? 409 : auth === 'Bearer revoked' ? 401 : 500;
    res.writeHead(status, { 'content-type': 'application/json' }).end('{}');
  });
  await new Promise<void>((done) => {
    server.listen(0, '127.0.0.1', done);
  });
  process.env.METRO_URL = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(() => {
  server.close();
  if (KEEP === undefined) delete process.env.METRO_URL;
  else process.env.METRO_URL = KEEP;
});

describe('probing a stored run token before starting', () => {
  test('metro answering the config means the token is live', async () => {
    expect(await runTokenState('live')).toBe('ok');
  });

  test('401, 403 and 409 mean this machine no longer holds the agent', async () => {
    expect(await runTokenState('stale')).toBe('stale');
    expect(await runTokenState('revoked')).toBe('stale');
  });

  test('anything else is treated as unreachable, and the daemon gets to retry', async () => {
    expect(await runTokenState('broken')).toBe('unreachable');
    process.env.METRO_URL = 'http://127.0.0.1:9';
    expect(await runTokenState('live')).toBe('unreachable');
  });
});
