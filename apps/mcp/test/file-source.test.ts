import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentFileError,
  type AgentFile,
  fileSource,
  listAgentFiles,
  loadFileAgents,
  parseAgentFile,
} from '../src/db/file-source.ts';
import { materializeFrom, stationRunsHere } from '../src/db/materialize.ts';

const KEY = `mk_${'a'.repeat(43)}`;
const OWNER = '0xef8305e140ac520225daf050e2f71d5fbcc543e7';
const saved = {
  agents: process.env.METRO_AGENTS_DIR,
  mode: process.env.METRO_MODE,
  file: process.env.TELEGRAM_BOT_ACCOUNTS_FILE,
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

function write(name: string, body: unknown): string {
  const folder = join(dir, name);
  mkdirSync(folder, { recursive: true });
  const path = join(folder, 'agent.json');
  writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body));
  return path;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'metro-agents-'));
  process.env.METRO_AGENTS_DIR = dir;
  process.env.METRO_MODE = 'local';
  process.env.TELEGRAM_BOT_ACCOUNTS_FILE = join(dir, 'telegram-bot-accounts.json');
});

afterEach(() => {
  for (const [key, value] of [
    ['METRO_AGENTS_DIR', saved.agents],
    ['METRO_MODE', saved.mode],
    ['TELEGRAM_BOT_ACCOUNTS_FILE', saved.file],
  ] as const)
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  rmSync(dir, { recursive: true, force: true });
});

describe('agents kept as files', () => {
  test('every agent.json under the agents dir is an agent, others are ignored', () => {
    write('suzy', agent());
    write('tony', agent({ id: 'agent000002', name: 'tony', key: `mk_${'b'.repeat(43)}`, stations: [] }));
    mkdirSync(join(dir, 'empty-folder'));
    writeFileSync(join(dir, 'stray.json'), '{}');
    expect(listAgentFiles(dir)).toHaveLength(2);
    const loaded = loadFileAgents(dir);
    expect(loaded.map((a) => [a.id, a.name, a.key, a.accounts.length])).toEqual([
      ['agent000001', 'suzy', KEY, 1],
      ['agent000002', 'tony', `mk_${'b'.repeat(43)}`, 0],
    ]);
    expect(loaded[0]?.accounts[0]).toEqual({
      station: 'telegram-bot',
      id: 'stn00000001',
      allowlist: ['*'],
      config: { botToken: 'secret-token' },
    });
  });

  test('a missing dir is no agents, and an empty one materializes only when allowed', async () => {
    expect(loadFileAgents(join(dir, 'nowhere'))).toEqual([]);
    await expect(materializeFrom(fileSource)).rejects.toThrow(/no agents found/);
    await materializeFrom(fileSource, { allowEmpty: true });
  });

  test('a station in a file runs on this machine', async () => {
    write('suzy', agent());
    expect(stationRunsHere('telegram-bot')).toBe(true);
    await materializeFrom(fileSource);
    const written = JSON.parse(
      readFileSync(process.env.TELEGRAM_BOT_ACCOUNTS_FILE ?? '', 'utf8'),
    ) as { id: string; botToken: string }[];
    expect(written).toEqual([{ id: 'stn00000001', botToken: 'secret-token' }]);
  });

  test('a key or owner may be absent, nothing else may', () => {
    const parsed = parseAgentFile(JSON.stringify(agent({ key: null, owner: undefined })), 'x');
    expect([parsed.key, parsed.owner]).toEqual([null, null]);
    for (const [over, reason] of [
      [{ version: 2 }, 'version'],
      [{ id: 'short' }, 'id'],
      [{ name: 'has space' }, 'name'],
      [{ key: 'mk_short' }, 'key'],
      [{ owner: '0xEF8305E140AC520225DAF050E2F71D5FBCC543E7' }, 'owner'],
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

  test('two files sharing an id or a key are refused, naming both', () => {
    write('suzy', agent());
    write('copy', agent({ name: 'copy' }));
    expect(() => loadFileAgents(dir)).toThrow('already used');
    rmSync(join(dir, 'copy'), { recursive: true });
    write('twin', agent({ id: 'agent000002', name: 'twin' }));
    expect(() => loadFileAgents(dir)).toThrow('key is already used');
  });
});
