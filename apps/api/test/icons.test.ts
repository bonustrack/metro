import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomInt } from 'node:crypto';
import type { FetchLike } from '@metro-labs/core/stations/oauth';
import { Favicons } from '@metro-labs/connectors/favicons';
import { handleIconRequest } from '../src/icons.ts';

const asked: string[] = [];
const google: FetchLike = (input) => {
  asked.push(String(input));
  return Promise.resolve(new Response('png', { status: String(input).includes('notion.so') ? 200 : 404 }));
};

let server: Server;
let base = '';

beforeAll(async () => {
  const favicons = new Favicons(google, () => Date.now());
  server = createServer((req, res) => {
    if (!handleIconRequest(req, res, favicons)) res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(randomInt(10_000, 30_000), '127.0.0.1', resolve));
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});
afterAll(() => {
  server.close();
});

const icon = (site: string, method = 'GET') => fetch(`${base}/api/icons?site=${encodeURIComponent(site)}`, { method, redirect: 'manual' });

describe('GET /api/icons sends a site\'s real favicon, or nothing the page would draw as a globe', () => {
  test('a site with a favicon redirects to it, asked again at every page load', async () => {
    const res = await icon('notion.so');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://t1.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=https%3A%2F%2Fnotion.so&size=64');
    expect(res.headers.get('cache-control')).toBe('no-cache');
  });

  test('a site without one is a 404 with no image, and Google is asked once per site', async () => {
    const before = asked.length;
    expect((await icon('piston.box')).status).toBe(404);
    expect((await icon('PISTON.box')).status).toBe(404);
    expect(asked.length - before).toBe(1);
  });

  test('only a plain domain is accepted, and only GET or HEAD', async () => {
    for (const site of ['', 'localhost', 'a/b.com', 'x.com?y=1', '127.0.0.1:80', `${'a'.repeat(260)}.com`]) expect((await icon(site)).status).toBe(400);
    expect((await icon('notion.so', 'POST')).status).toBe(405);
  });
});
