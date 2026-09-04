import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localAgents, localDaemonUp, localMcpServers, pickLocalAgent } from '../src/local.ts';

const KEEP = { dir: process.env.METRO_AGENTS_DIR, port: process.env.METRO_WEBHOOK_PORT };
let dir = '';
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
  server = createServer((req, res) => {
    if (req.url === '/api/mode') {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"mode":"local"}');
      return;
    }
    if (req.url === '/api/cli/mcp' && req.headers.authorization === `Bearer ${'a1b2c3d4'.repeat(8)}`) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ json: '{"mcpServers":{}}', agent: 'tony' }));
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
  if (KEEP.dir === undefined) delete process.env.METRO_AGENTS_DIR;
  else process.env.METRO_AGENTS_DIR = KEEP.dir;
  if (KEEP.port === undefined) delete process.env.METRO_WEBHOOK_PORT;
  else process.env.METRO_WEBHOOK_PORT = KEEP.port;
});

describe('the agents a local daemon owns, as the CLI sees them', () => {
  test('one per readable agent.json, sorted by name, broken files skipped', () => {
    expect(localAgents(dir).map((a) => `${a.name}/${a.id}`)).toEqual(['suzy/agentSuzy01', 'tony/agentTony01']);
  });

  test('picking: by name or id, the sole one by default, otherwise ask', () => {
    const agents = localAgents(dir);
    expect(pickLocalAgent(agents, 'tony').id).toBe('agentTony01');
    expect(pickLocalAgent(agents, 'agentSuzy01').name).toBe('suzy');
    expect(() => pickLocalAgent(agents)).toThrow(/several agents on this machine — name one: suzy, tony/);
    expect(() => pickLocalAgent(agents, 'lisa')).toThrow(/no local agent named 'lisa'/);
    expect(pickLocalAgent(agents.slice(1)).name).toBe('tony');
    expect(() => pickLocalAgent([])).toThrow(/no agent on this machine yet/);
  });

  test('the local daemon is detected, and answers the connectors block for the agent key', async () => {
    expect(await localDaemonUp(base)).toBe(true);
    expect(await localDaemonUp('http://127.0.0.1:9')).toBe(false);
    const tony = pickLocalAgent(localAgents(dir), 'tony');
    expect(await localMcpServers(tony, base)).toBe('{"mcpServers":{}}');
    await expect(localMcpServers({ ...tony, key: 'wrong' }, base)).rejects.toThrow(/401/);
  });
});
