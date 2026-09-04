import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { materializeFrom, MOVABLE_STATIONS } from '../src/db/materialize.ts';
import { agentIdForKey } from '../src/db/key-map.ts';
import { agentIdForAccount } from '../src/db/agent-map.ts';

const KEEP = {
  file: process.env.TELEGRAM_BOT_ACCOUNTS_FILE,
  trains: process.env.METRO_TRAINS_DIR,
};
let dir = '';
let file = '';

beforeEach(() => {
  process.env.METRO_MODE = 'local';
  dir = mkdtempSync(join(tmpdir(), 'metro-source-'));
  file = join(dir, 'telegram-bot-accounts.json');
  process.env.TELEGRAM_BOT_ACCOUNTS_FILE = file;
  process.env.METRO_TRAINS_DIR = join(dir, 'trains');
});

afterEach(() => {
  delete process.env.METRO_MODE;
  if (KEEP.file === undefined) delete process.env.TELEGRAM_BOT_ACCOUNTS_FILE;
  else process.env.TELEGRAM_BOT_ACCOUNTS_FILE = KEEP.file;
  if (KEEP.trains === undefined) delete process.env.METRO_TRAINS_DIR;
  else process.env.METRO_TRAINS_DIR = KEEP.trains;
  rmSync(dir, { recursive: true, force: true });
});

const agent = (accounts: unknown[]) => ({
  id: 'agent000001',
  name: 'local',
  key: 'mk_test',
  accounts,
});

const telegramBot = (id: string, allowlist: string[]) => ({
  station: 'telegram-bot',
  id,
  allowlist,
  config: { botToken: 'secret-token' },
});

describe('materializing from an injected source', () => {
  test('an agent with no stations boots — it does not crash-loop', async () => {
    await materializeFrom(() => Promise.resolve([agent([])]));
  });

  test('no agents at all is still a loud failure', async () => {
    expect(materializeFrom(() => Promise.resolve([]))).rejects.toThrow(
      /no agents found/,
    );
  });

  test('a station record reaches its account file, written 0600', async () => {
    await materializeFrom(() =>
      Promise.resolve([agent([telegramBot('stn00000001', ['*'])])]),
    );
    expect(existsSync(file)).toBe(true);
    const written = JSON.parse(readFileSync(file, 'utf8')) as {
      id: string;
      botToken: string;
    }[];
    expect(written[0]?.id).toBe('stn00000001');
    expect(written[0]?.botToken).toBe('secret-token');
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test('the allowlist is relay-only and never reaches the train file', async () => {
    await materializeFrom(() =>
      Promise.resolve([agent([telegramBot('stn00000002', ['alice'])])]),
    );
    expect(readFileSync(file, 'utf8')).not.toContain('alice');
  });
});

describe('an agent held by a local runtime is not served by the hosted daemon', () => {
  const moved = {
    id: 'agent000009',
    name: 'moved',
    key: null,
    accounts: [
      {
        station: 'telegram-bot',
        id: 'stn00000088',
        allowlist: ['*'],
        config: { botToken: 'held-secret' },
      },
    ],
  };

  test('its key does not register, so a hosted connection is a clean 401', async () => {
    await materializeFrom(() => Promise.resolve([moved]));
    expect(agentIdForKey('mk_test')).toBeUndefined();
  });

  test('its stations still ATTRIBUTE, so the panel can list them', async () => {
    delete process.env.METRO_MODE;
    await materializeFrom(() => Promise.resolve([moved]));
    expect(agentIdForAccount('telegram-bot', 'stn00000088')).toBe('agent000009');
    expect(existsSync(file)).toBe(false);
  });

  test('but it still counts as an agent, so boot does not crash-loop', async () => {
    await materializeFrom(() => Promise.resolve([moved]));
    expect(agentIdForKey('anything')).toBeUndefined();
  });
});

describe('metro never runs a messenger station, held or not', () => {
  test('the movable set is every station except webhook', () => {
    expect([...MOVABLE_STATIONS].sort()).toEqual([
      'discord-bot',
      'telegram',
      'telegram-bot',
      'whatsapp',
      'xmtp',
    ]);
    expect(MOVABLE_STATIONS.has('webhook' as never)).toBe(false);
  });

  test('an agent with no stations writes no account file', async () => {
    await materializeFrom(() =>
      Promise.resolve([
        { id: 'agent000001', name: 'local', key: 'mk', accounts: [] },
      ]),
    );
    expect(existsSync(file)).toBe(false);
  });
});

describe('the panel lists what exists, not what happens to be running', () => {
  test('a station metro does not run is not reported as unavailable', async () => {
    delete process.env.METRO_MODE;
    const { setTrainCallBackend } = await import('../src/daemon/train-call.ts');
    const { gatherAccountsForAgents } = await import('../src/mcp/accounts.ts');
    const { setAgentMap } = await import('../src/db/agent-map.ts');
    setAgentMap({ 'telegram-bot/t0': 'agent000001' }, { agent000001: 'Tony' });
    setTrainCallBackend(() => Promise.reject(new Error('no such train')));
    const { unavailable } = await gatherAccountsForAgents(
      new Set(['agent000001']),
    );
    expect(unavailable).toEqual([]);
  });
});

describe('a station name this build does not know', () => {
  test('is skipped with an error, never a crash — version skew must not brick the daemon', async () => {
    await materializeFrom(() =>
      Promise.resolve([
        agent([
          { station: 'from-the-future', id: 'stn00000009', allowlist: ['*'], config: {} },
          telegramBot('stn00000010', ['*']),
        ]),
      ]),
    );
    expect(existsSync(file)).toBe(true);
  });
});

describe('an unchanged poll changes nothing, so trains are not restarted', () => {
  const source = () =>
    Promise.resolve([agent([telegramBot('stn00000042', ['*'])])]);

  test('the second identical reload reports zero changed stations', async () => {
    const { reloadFrom } = await import('../src/db/materialize.ts');
    const first = await reloadFrom(source);
    expect(first.changed).toEqual(['telegram-bot']);
    const second = await reloadFrom(source);
    expect(second.changed).toEqual([]);
    expect(second.active).toContain('telegram-bot');
  });

  test('a credential change is reported for exactly that station', async () => {
    const { reloadFrom } = await import('../src/db/materialize.ts');
    await reloadFrom(source);
    const rotated = () =>
      Promise.resolve([
        agent([
          {
            station: 'telegram-bot',
            id: 'stn00000042',
            allowlist: ['*'],
            config: { botToken: 'rotated-token' },
          },
        ]),
      ]);
    const after = await reloadFrom(rotated);
    expect(after.changed).toEqual(['telegram-bot']);
  });
});

describe('a pruned station stays pruned quietly', () => {
  test('removal is reported once, not on every later reload', async () => {
    const { reloadFrom } = await import('../src/db/materialize.ts');
    const withStation = () =>
      Promise.resolve([agent([telegramBot('stn00000077', ['*'])])]);
    const without = () =>
      Promise.resolve([
        { id: 'agent000001', name: 'local', key: 'mk', accounts: [] },
      ]);
    await reloadFrom(withStation);
    const gone = await reloadFrom(without);
    expect(gone.removed).toEqual(['telegram-bot']);
    const again = await reloadFrom(without);
    expect(again.removed).toEqual([]);
  });
});
