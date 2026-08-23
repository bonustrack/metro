import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { materializeFrom, MOVABLE_STATIONS } from '../src/db/materialize.ts';
import { agentIdForKey } from '../src/db/key-map.ts';

const KEEP = { file: process.env.TELEGRAM_ACCOUNTS_FILE };
let dir = '';
let file = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'metro-source-'));
  file = join(dir, 'telegram-accounts.json');
  process.env.TELEGRAM_ACCOUNTS_FILE = file;
});

afterEach(() => {
  if (KEEP.file === undefined) delete process.env.TELEGRAM_ACCOUNTS_FILE;
  else process.env.TELEGRAM_ACCOUNTS_FILE = KEEP.file;
  rmSync(dir, { recursive: true, force: true });
});

const agent = (accounts: unknown[]) => ({
  id: 'agent000001',
  name: 'local',
  key: 'mk_test',
  accounts,
});

const telegram = (id: string, allowlist: string[]) => ({
  station: 'telegram',
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
      Promise.resolve([agent([telegram('stn00000001', ['*'])])]),
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
      Promise.resolve([agent([telegram('stn00000002', ['alice'])])]),
    );
    expect(readFileSync(file, 'utf8')).not.toContain('alice');
  });
});

describe('an agent held by a local runtime is not served by the hosted daemon', () => {
  const moved = { id: 'agent000009', name: 'moved', key: null, accounts: [] };

  test('its key does not register, so a hosted connection is a clean 401', async () => {
    await materializeFrom(() => Promise.resolve([moved]));
    expect(agentIdForKey('mk_test')).toBeUndefined();
  });

  test('but it still counts as an agent, so boot does not crash-loop', async () => {
    await materializeFrom(() => Promise.resolve([moved]));
    expect(agentIdForKey('anything')).toBeUndefined();
  });
});

describe('metro never runs a messenger station, held or not', () => {
  test('the movable set is every station except webhook', () => {
    expect([...MOVABLE_STATIONS].sort()).toEqual([
      'discord',
      'telegram',
      'telegram-user',
      'whatsapp',
      'xmtp',
    ]);
    expect(MOVABLE_STATIONS.has('webhook' as never)).toBe(false);
  });

  test('a messenger station simply does not run until a machine claims it', async () => {
    await materializeFrom(() =>
      Promise.resolve([agent([telegram('stn00000003', ['*'])])]),
    );
    expect(existsSync(file)).toBe(true);
    rmSync(file, { force: true });
    await materializeFrom(() =>
      Promise.resolve([
        { id: 'agent000001', name: 'local', key: 'mk', accounts: [] },
      ]),
    );
    expect(existsSync(file)).toBe(false);
  });
});
