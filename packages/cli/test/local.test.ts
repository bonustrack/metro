import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localAgent, localDaemonUp, localStations } from '../src/local.ts';

const KEEP = { dir: process.env.METRO_AGENTS_DIR, port: process.env.METRO_WEBHOOK_PORT };
let dir = '';
let fixed = '';
let server: Server;
let base = '';

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'metro-cli-local-'));
  writeFileSync(join(dir, 'agent.json'), '{not json');
  fixed = mkdtempSync(join(tmpdir(), 'metro-cli-fixed-'));
  writeFileSync(join(fixed, 'agent.json'), JSON.stringify({ version: 1, id: 'agentOnly001', key: `mk_${'f'.repeat(43)}`, stations: [{ station: 'xmtp', id: 'stn00000001', config: {} }] }));
  server = createServer((req, res) => {
    if (req.url === '/api/mode') {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"mode":"local"}');
      return;
    }
    res.writeHead(401).end();
  });
  await new Promise<void>((done) => {
    server.listen(0, '127.0.0.1', done);
  });
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(fixed, { recursive: true, force: true });
  if (KEEP.dir === undefined) delete process.env.METRO_AGENTS_DIR;
  else process.env.METRO_AGENTS_DIR = KEEP.dir;
  if (KEEP.port === undefined) delete process.env.METRO_WEBHOOK_PORT;
  else process.env.METRO_WEBHOOK_PORT = KEEP.port;
});

describe('the agents a local daemon owns, as the CLI sees them', () => {
  test('the agent.json carries the id, key and stations, and a broken one is no agent', () => {
    expect(localAgent(fixed)).toEqual({ id: 'agentOnly001', key: `mk_${'f'.repeat(43)}` });
    expect(localStations(fixed)).toEqual(['xmtp']);
    expect(localAgent(dir)).toBeNull();
    expect(localStations(dir)).toEqual([]);
  });

  test('the local daemon is detected', async () => {
    expect(await localDaemonUp(base)).toBe(true);
    expect(await localDaemonUp('http://127.0.0.1:9')).toBe(false);
  });
});
