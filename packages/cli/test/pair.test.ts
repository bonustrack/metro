import { afterEach, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { claimCode } from '../src/api.ts';

const saved = { ...process.env };
let server: Server | null = null;
let seen = '';

afterEach(() => {
  process.env = { ...saved };
  server?.close();
  server = null;
  seen = '';
});

async function serve(status: number, body: unknown): Promise<void> {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      seen = Buffer.concat(chunks).toString('utf8');
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  const live = server;
  await new Promise<void>((done) => {
    live.listen(0, '127.0.0.1', done);
  });
  const { port } = live.address() as AddressInfo;
  process.env.METRO_URL = `http://127.0.0.1:${String(port)}`;
}

describe('trading a pairing code for a session', () => {
  test('a good code comes back as a token bound to one named agent', async () => {
    await serve(200, {
      token: 'cli-token',
      subject: '0xef8305e140ac520225daf050e2f71d5fbcc543e7',
      agent: 'suzy',
    });
    expect(await claimCode('ma_abcdefghijklmnop')).toEqual({
      token: 'cli-token',
      subject: '0xef8305e140ac520225daf050e2f71d5fbcc543e7',
      agent: 'suzy',
    });
    expect(JSON.parse(seen)).toEqual({ code: 'ma_abcdefghijklmnop' });
  });

  test('a response missing the agent is refused rather than half-used', async () => {
    await serve(200, { token: 'cli-token', subject: '0xef8305e140ac520225daf050e2f71d5fbcc543e7' });
    expect(claimCode('ma_abcdefghijklmnop')).rejects.toThrow('unexpected');
  });

  test("metro's own words reach the user, not a bare status code", async () => {
    await serve(400, { error: 'that code has expired or was already used' });
    expect(claimCode('ma_abcdefghijklmnop')).rejects.toThrow(
      'that code has expired or was already used',
    );
  });

  test('a refusal with no message still fails rather than looking like success', async () => {
    await serve(500, {});
    expect(claimCode('ma_abcdefghijklmnop')).rejects.toThrow('metro answered 500');
  });

  test('the code never goes out over plaintext to a remote host', async () => {
    process.env.METRO_URL = 'http://mcp.metro.box';
    expect(claimCode('ma_abcdefghijklmnop')).rejects.toThrow('in the clear');
  });
});
