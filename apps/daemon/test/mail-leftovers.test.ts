import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { log } from '@metro-labs/core/log';
import { removeMailLeftovers } from '../src/boot/mail-leftovers.ts';
import { loadFileAgents, parseAgentFile } from '../src/agents/files.ts';

const ENVS = ['OUTLOOK_STATE_DIR', 'GMAIL_STATE_DIR', 'OUTLOOK_ACCOUNTS_FILE', 'GMAIL_ACCOUNTS_FILE'] as const;

const TELEGRAM = { station: 'telegram-bot', id: 'tbot0000001', allowlist: ['*'], enabled: true, config: { token: 'bot-token' } };
const GMAIL = { station: 'gmail', id: 'gmail000001', allowlist: ['*'], enabled: true, config: { refreshToken: 'gmail-refresh-secret', clientSecret: 'GOCSPX-secret' } };
const OUTLOOK = { station: 'outlook', id: 'outlk000001', allowlist: ['@anderra.ch'], approvers: [], enabled: false, policy: { write: 'ask' }, config: { refreshToken: 'outlook-refresh-secret' } };

const LEFTOVERS = {
  state: ['outlook-state-outlk000001.json', 'outlook-state-gone_00001.json.tmp-4242', 'gmail-state-gmail000001.json', 'gmail-state-old-one.json'],
  accounts: ['outlook-accounts.json', 'gmail-accounts.json', 'gmail-accounts.json.tmp-7'],
  trains: ['gmail.ts', 'outlook.ts'],
  agents: ['.gmail-host', '.gmail-host.tmp-12'],
};

const KEPT = {
  state: ['whatsapp-tokens-wapp0000001.json', 'threema-groups-thr00000001.json', 'outlook-state-.json', 'outlook-state-a.json.bak', 'gmail-state-a.json.tmp', 'xmtp-production-abcd.db3'],
  accounts: ['telegram-bot-accounts.json', 'outlook-accounts.json.bak', 'old-gmail-accounts.json'],
  trains: ['telegram-bot.ts', 'xmtp.ts', 'outlook.ts.bak', 'gmail.js'],
  agents: ['.owner', 'mcp-token', '.gmail-host.bak'],
};

let root = '';
const dirs = { state: '', accounts: '', trains: '', agents: '' };

const agentPath = (): string => join(dirs.agents, 'agent.json');
const names = (dir: string): string[] => readdirSync(dir).sort();
const writeAll = (dir: string, files: string[]): void => {
  for (const name of files) writeFileSync(join(dir, name), `content of ${name}`);
};
const writeAgent = (stations: unknown[]): void => {
  writeFileSync(agentPath(), `${JSON.stringify({ version: 1, id: 'agent000001', name: 'tony', key: 'secret-agent-key-0123456789', stations }, null, 2)}\n`);
};
const run = (): { accounts: number; files: number } => removeMailLeftovers({ agents: dirs.agents, trains: dirs.trains });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'metro-mail-leftovers-'));
  for (const key of Object.keys(dirs) as (keyof typeof dirs)[]) {
    dirs[key] = join(root, key);
    mkdirSync(dirs[key]);
  }
  process.env.OUTLOOK_STATE_DIR = dirs.state;
  process.env.GMAIL_STATE_DIR = dirs.state;
  process.env.OUTLOOK_ACCOUNTS_FILE = join(dirs.accounts, 'outlook-accounts.json');
  process.env.GMAIL_ACCOUNTS_FILE = join(dirs.accounts, 'gmail-accounts.json');
});

afterEach(() => {
  for (const env of ENVS) delete process.env[env];
  rmSync(root, { recursive: true, force: true });
});

describe('the boot cleanup of the old Gmail and Outlook channels', () => {
  test('their accounts leave agent.json and everything else in it stays', () => {
    writeAgent([GMAIL, TELEGRAM, OUTLOOK]);
    const info = spyOn(log, 'info');
    try {
      expect(run()).toEqual({ accounts: 2, files: 0 });
      const lines = info.mock.calls.filter((call) => String(call[1]).startsWith('mail: removed'));
      expect(lines).toEqual([[{ accounts: 2, files: 0 }, 'mail: removed the old Gmail and Outlook channels, which are connectors now']]);
    } finally {
      info.mockRestore();
    }
    const text = readFileSync(agentPath(), 'utf8');
    expect(JSON.parse(text)).toEqual({ version: 1, id: 'agent000001', name: 'tony', key: 'secret-agent-key-0123456789', stations: [TELEGRAM] });
    expect(text).not.toContain('refresh-secret');
    expect((lstatSync(agentPath()).mode & 0o777).toString(8)).toBe('600');
    expect(loadFileAgents(dirs.agents)[0]?.accounts.map((a) => a.station)).toEqual(['telegram-bot']);
  });

  test('an agent.json without them is not rewritten', () => {
    writeAgent([TELEGRAM]);
    const before = readFileSync(agentPath(), 'utf8');
    chmodSync(agentPath(), 0o640);
    expect(run().accounts).toBe(0);
    expect(readFileSync(agentPath(), 'utf8')).toBe(before);
    expect((lstatSync(agentPath()).mode & 0o777).toString(8)).toBe('640');
  });

  test('their token, account and train files go, with temp files, and every other file stays byte for byte', () => {
    writeAgent([TELEGRAM]);
    for (const key of Object.keys(dirs) as (keyof typeof dirs)[]) writeAll(dirs[key], [...LEFTOVERS[key], ...KEPT[key]]);
    const all = Object.values(LEFTOVERS).flat().length;
    expect(run()).toEqual({ accounts: 0, files: all });
    for (const key of Object.keys(dirs) as (keyof typeof dirs)[]) {
      const expected = key === 'agents' ? [...KEPT[key], 'agent.json'] : KEPT[key];
      expect(names(dirs[key])).toEqual([...expected].sort());
      for (const name of KEPT[key]) expect(readFileSync(join(dirs[key], name), 'utf8')).toBe(`content of ${name}`);
    }
  });

  test('a symlink or a folder with a leftover name is left alone, and its target is never touched', () => {
    const target = join(root, 'elsewhere.json');
    writeFileSync(target, 'not metro');
    symlinkSync(target, join(dirs.state, 'outlook-state-outlk000001.json'));
    symlinkSync(join(root, 'missing.json'), join(dirs.trains, 'gmail.ts'));
    mkdirSync(join(dirs.accounts, 'gmail-accounts.json'));
    writeFileSync(join(dirs.trains, 'outlook.ts'), "import '@metro-labs/outlook/train';\n");
    const warn = spyOn(log, 'warn');
    try {
      expect(run()).toEqual({ accounts: 0, files: 1 });
      expect(warn).toHaveBeenCalledTimes(3);
    } finally {
      warn.mockRestore();
    }
    expect(lstatSync(join(dirs.state, 'outlook-state-outlk000001.json')).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(dirs.trains, 'gmail.ts')).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(dirs.accounts, 'gmail-accounts.json')).isDirectory()).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('not metro');
    expect(existsSync(join(dirs.trains, 'outlook.ts'))).toBe(false);
  });

  test('a box with no agent and no folders is fine and logs no warning', () => {
    rmSync(root, { recursive: true, force: true });
    mkdirSync(dirs.agents, { recursive: true });
    const warn = spyOn(log, 'warn');
    try {
      expect(run()).toEqual({ accounts: 0, files: 0 });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test('an agent.json it cannot read is left as it is, the files still go, and nothing throws', () => {
    writeFileSync(agentPath(), '{ not json');
    writeAll(dirs.state, ['gmail-state-gmail000001.json']);
    const warn = spyOn(log, 'warn');
    try {
      expect(run()).toEqual({ accounts: 0, files: 1 });
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
    expect(readFileSync(agentPath(), 'utf8')).toBe('{ not json');
  });

  test('a failed write of agent.json is a warning, never a crash, and the files still go', () => {
    writeAgent([GMAIL, TELEGRAM]);
    writeAll(dirs.state, ['gmail-state-gmail000001.json']);
    mkdirSync(`${agentPath()}.tmp-${String(process.pid)}`);
    const warn = spyOn(log, 'warn');
    try {
      expect(run()).toEqual({ accounts: 0, files: 1 });
      expect(warn.mock.calls.some((call) => String(call[1]).includes('could not remove the accounts'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  test('running it again removes nothing more', () => {
    writeAgent([GMAIL, OUTLOOK, TELEGRAM]);
    for (const key of Object.keys(dirs) as (keyof typeof dirs)[]) writeAll(dirs[key], [...LEFTOVERS[key], ...KEPT[key]]);
    expect(run().accounts).toBe(2);
    const after = readFileSync(agentPath(), 'utf8');
    expect(run()).toEqual({ accounts: 0, files: 0 });
    expect(readFileSync(agentPath(), 'utf8')).toBe(after);
  });
});

describe('an agent file that still names Gmail or Outlook', () => {
  test('parses, without those accounts, instead of stopping the daemon at boot', () => {
    const raw = JSON.stringify({ version: 1, id: 'agent000001', key: 'secret-agent-key-0123456789', stations: [GMAIL, TELEGRAM, OUTLOOK] });
    expect(parseAgentFile(raw, 'agent.json').stations.map((s) => s.station)).toEqual(['telegram-bot']);
    expect(() => parseAgentFile(JSON.stringify({ version: 1, id: 'agent000001', stations: [{ ...TELEGRAM, station: 'line' }] }), 'agent.json')).toThrow('not a known station');
  });
});
