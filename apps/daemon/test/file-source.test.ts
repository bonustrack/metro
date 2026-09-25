import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentFileError, fileSource, listAgentFiles, loadFileAgents, parseAgentFile, readAgentFile, type AgentFile } from '../src/agents/files.ts';
import { materializeFrom } from '../src/stations/materialize.ts';

const KEY = `mk_${'a'.repeat(43)}`;
const OWNER = '0xef8305e140ac520225daf050e2f71d5fbcc543e7';
const saved = {
  agents: process.env.METRO_AGENTS_DIR,
  file: process.env.TELEGRAM_BOT_ACCOUNTS_FILE,
  trains: process.env.METRO_TRAINS_DIR,
};
let dir = '';

const agent = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  version: 1,
  id: 'agent000001',
  name: 'suzy',
  key: KEY,
  owner: OWNER,
  stations: [
    {
      station: 'telegram-bot',
      id: 'stn00000001',
      allowlist: ['*'],
      config: { botToken: 'secret-token' },
    },
  ],
  ...over,
});

function write(body: unknown): string {
  const path = join(dir, 'agent.json');
  writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body));
  return path;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'metro-agents-'));
  process.env.METRO_AGENTS_DIR = dir;
  process.env.TELEGRAM_BOT_ACCOUNTS_FILE = join(dir, 'telegram-bot-accounts.json');
  process.env.METRO_TRAINS_DIR = join(dir, 'trains');
});

afterEach(() => {
  for (const [key, value] of [
    ['METRO_AGENTS_DIR', saved.agents],
    ['TELEGRAM_BOT_ACCOUNTS_FILE', saved.file],
    ['METRO_TRAINS_DIR', saved.trains],
  ] as const)
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  rmSync(dir, { recursive: true, force: true });
});

describe('agents kept as files', () => {
  test('only agent.json at the top of the agents dir is the agent, anything else is ignored', () => {
    write(agent());
    mkdirSync(join(dir, 'tony'));
    writeFileSync(join(dir, 'tony', 'agent.json'), JSON.stringify(agent({ id: 'agent000002', name: 'tony', stations: [] })));
    writeFileSync(join(dir, 'stray.json'), '{}');
    expect(listAgentFiles(dir)).toEqual([join(dir, 'agent.json')]);
    const loaded = loadFileAgents(dir);
    expect(loaded.map((a) => [a.id, a.name, a.key, a.accounts.length])).toEqual([['agent000001', 'suzy', KEY, 1]]);
    expect(loaded[0]?.accounts[0]).toEqual({
      station: 'telegram-bot',
      id: 'stn00000001',
      allowlist: ['*'],
      enabled: true,
      config: { botToken: 'secret-token' },
    });
  });

  test('a missing dir is no agents, and an empty one still materializes', async () => {
    expect(loadFileAgents(join(dir, 'nowhere'))).toEqual([]);
    await materializeFrom(fileSource);
  });

  test('a station is on unless its file says enabled: false, and the flag survives the load', async () => {
    write(agent({ stations: [
      { station: 'telegram-bot', id: 'stn00000001', allowlist: ['*'], config: { botToken: 'a' } },
      { station: 'telegram-bot', id: 'stn00000002', allowlist: ['*'], enabled: false, config: { botToken: 'b' } },
    ] }));
    const [loaded] = await fileSource();
    expect(loaded?.accounts.map((a) => [a.id, a.enabled])).toEqual([['stn00000001', true], ['stn00000002', false]]);
  });

  test('a station in a file runs on this machine', async () => {
    write(agent());
    await materializeFrom(fileSource);
    const written = JSON.parse(
      readFileSync(process.env.TELEGRAM_BOT_ACCOUNTS_FILE ?? '', 'utf8'),
    ) as { id: string; botToken: string }[];
    expect(written).toEqual([{ id: 'stn00000001', botToken: 'secret-token' }]);
  });

  test('a key may be absent, an old owner or connectors key is ignored, nothing else may be wrong', () => {
    expect(parseAgentFile(JSON.stringify(agent({ key: null })), 'x').key).toBeNull();
    const old = parseAgentFile(JSON.stringify(agent({ owner: 'anything', connectors: ['x'] })), 'x');
    expect(old).not.toHaveProperty('owner');
    expect(old).not.toHaveProperty('connectors');
    for (const [over, reason] of [
      [{ version: 2 }, 'version'],
      [{ id: 'short' }, 'id'],
      [{ name: 'has space' }, 'name'],
      [{ key: 'mk_short' }, 'key'],
      [{ stations: {} }, 'stations'],
      [{ stations: [{ station: 'line', id: 'stn00000001', config: {} }] }, 'station'],
      [{ stations: [{ station: 'xmtp', id: 'nope', config: {} }] }, 'id'],
      [{ stations: [{ station: 'xmtp', id: 'stn00000001', config: 'x' }] }, 'config'],
      [{ stations: [{ station: 'xmtp', id: 'stn00000001', allowlist: 'x', config: {} }] }, 'allowlist'],
    ] as const) {
      const attempt = (): AgentFile => parseAgentFile(JSON.stringify(agent(over)), 'suzy/agent.json');
      expect(attempt).toThrow(AgentFileError);
      expect(attempt).toThrow(reason);
      expect(attempt).toThrow('suzy/agent.json');
    }
    expect(() => parseAgentFile('{not json', 'p')).toThrow('not valid JSON');
  });
});

describe('train stubs at first boot', () => {
  test('a stale stub for a station with no account is removed and the live one is written', async () => {
    write(agent());
    const trains = join(dir, 'trains');
    mkdirSync(trains, { recursive: true });
    writeFileSync(join(trains, 'discord-bot.ts'), "import '@metro-labs/discord-bot/train';\n");
    await materializeFrom(fileSource);
    expect(existsSync(join(trains, 'discord-bot.ts'))).toBe(false);
    expect(readFileSync(join(trains, 'telegram-bot.ts'), 'utf8')).toBe(
      "import '@metro-labs/telegram-bot/train';\n",
    );
  });
});

describe('keys of every vintage', () => {
  test("metro.box keys older than today's mk_ shape, plain 64-hex included, are still keys", () => {
    const hex = 'a1b2c3d4'.repeat(8);
    expect(hex).toHaveLength(64);
    expect(readAgentFile(write(agent({ key: hex }))).key).toBe(hex);
    const mid = `mk_${'A1b2'.repeat(15)}z`;
    expect(readAgentFile(write(agent({ id: 'agent000002', key: mid }))).key).toBe(mid);
  });

  test('but not something too short, or carrying a character a url would mangle', () => {
    expect(() => readAgentFile(write(agent({ key: 'mk_short' })))).toThrow(/not an agent key/);
    const spaced = write(agent({ id: 'agent000002', key: `mk_${'x'.repeat(20)} y` }));
    expect(() => readAgentFile(spaced)).toThrow(/not an agent key/);
    const plus = write(agent({ id: 'agent000003', key: `${'x'.repeat(20)}+/=` }));
    expect(() => readAgentFile(plus)).toThrow(/not an agent key/);
  });
});
