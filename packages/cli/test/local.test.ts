import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  for (const [name, id, key] of [
    ['tony', 'agentTony01', 'a1b2c3d4'.repeat(8)],
    ['suzy', 'agentSuzy01', `mk_${'s'.repeat(43)}`],
  ])
    (mkdirSync(join(dir, name), { recursive: true }),
    writeFileSync(join(dir, name, 'agent.json'), JSON.stringify({ version: 1, id, name, key, owner: null, stations: [] })));
  mkdirSync(join(dir, 'broken'), { recursive: true });
  writeFileSync(join(dir, 'broken', 'agent.json'), '{not json');
  fixed = mkdtempSync(join(tmpdir(), 'metro-cli-fixed-'));
  writeFileSync(join(fixed, 'agent.json'), JSON.stringify({ version: 1, id: 'agentOnly001', name: null, key: `mk_${'f'.repeat(43)}`, owner: null, stations: [{ station: 'xmtp', id: 'stn00000001', config: {} }] }));
  mkdirSync(join(fixed, 'Old'), { recursive: true });
  writeFileSync(join(fixed, 'Old', 'agent.json'), JSON.stringify({ version: 1, id: 'agentOld0001', name: 'Old', key: `mk_${'o'.repeat(43)}`, owner: null, stations: [] }));
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
  test('only the fixed agent.json counts, needs no name, and carries the stations', () => {
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
