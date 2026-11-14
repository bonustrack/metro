import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeMailLeftovers } from '../src/boot/mail-leftovers.ts';
import { loadFileAgents, parseAgentFile } from '../src/agents/files.ts';
import { eventInScope } from '../src/agents/scope.ts';

const ENVS = ['OUTLOOK_STATE_DIR', 'GMAIL_STATE_DIR', 'OUTLOOK_ACCOUNTS_FILE', 'GMAIL_ACCOUNTS_FILE'] as const;

let root = '';
let agents = '';
let trains = '';
let state = '';

const agentFile = (): string => join(agents, 'agent.json');
const kept = { station: 'telegram-bot', id: 'tb000000001', allowlist: ['*'], enabled: true, config: { token: 'bot-token' } };
const gmail = { station: 'gmail', id: 'gm000000001', allowlist: ['owner@example.com'], approvers: ['owner@example.com'], policy: { write: 'deny' }, config: { refreshToken: 'gmail-secret', managed: true } };
const outlook = { station: 'outlook', id: 'ol000000001', allowlist: ['@anderra.ch'], enabled: false, config: { refreshToken: 'outlook-secret' } };

function writeAgent(stations: unknown[]): void {
  writeFileSync(agentFile(), JSON.stringify({ version: 1, id: 'agent000001', name: 'Andy', key: 'key-0123456789abcdef', stations }));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'metro-mail-leftovers-'));
  agents = join(root, 'agents');
  trains = join(root, 'trains');
  state = join(root, 'state');
  for (const dir of [agents, trains, state]) mkdirSync(dir);
  process.env.OUTLOOK_STATE_DIR = state;
  process.env.GMAIL_STATE_DIR = state;
  process.env.OUTLOOK_ACCOUNTS_FILE = join(state, 'outlook-accounts.json');
  process.env.GMAIL_ACCOUNTS_FILE = join(state, 'gmail-accounts.json');
});

afterEach(() => {
  for (const env of ENVS) delete process.env[env];
  rmSync(root, { recursive: true, force: true });
});

describe('a box that still has Gmail or Outlook channels when it updates', () => {
  test('the mail accounts leave agent.json and everything else stays as it was', () => {
    writeAgent([gmail, kept, outlook]);
    expect(removeMailLeftovers({ agents, trains })).toEqual({ accounts: 2, files: 0 });
    const after = JSON.parse(readFileSync(agentFile(), 'utf8')) as Record<string, unknown>;
    expect(after).toEqual({ version: 1, id: 'agent000001', name: 'Andy', key: 'key-0123456789abcdef', stations: [kept] });
    expect(lstatSync(agentFile()).mode & 0o777).toBe(0o600);
    expect(parseAgentFile(readFileSync(agentFile(), 'utf8'), agentFile()).stations.map((s) => s.station)).toEqual(['telegram-bot']);
  });

  test('their state, account files and train stubs go; other stations keep theirs', () => {
    writeAgent([kept]);
    const gone = [
      join(state, 'outlook-state-ol000000001.json'),
      join(state, 'outlook-state-ol000000001.json.tmp-4242'),
      join(state, 'gmail-state-gm000000001.json'),
      join(state, 'outlook-accounts.json'),
      join(state, 'gmail-accounts.json'),
      join(state, 'gmail-accounts.json.tmp-7'),
      join(trains, 'gmail.ts'),
      join(trains, 'outlook.ts'),
      join(agents, '.gmail-host'),
    ];
    const stay = [
      join(state, 'whatsapp-tokens-wa000000001.json'),
      join(state, 'outlook-state-notes.txt'),
      join(state, 'telegram-bot-accounts.json'),
      join(trains, 'telegram-bot.ts'),
      join(agents, '.owner'),
    ];
    for (const path of [...gone, ...stay]) writeFileSync(path, '{}');
    expect(removeMailLeftovers({ agents, trains })).toEqual({ accounts: 0, files: gone.length });
    for (const path of gone) expect(existsSync(path)).toBe(false);
    for (const path of stay) expect(existsSync(path)).toBe(true);
  });

  test('a symlink or a folder with a mail file name is left alone', () => {
    const target = join(root, 'precious.json');
    writeFileSync(target, 'keep me');
    symlinkSync(target, join(state, 'gmail-state-gm000000001.json'));
    mkdirSync(join(state, 'outlook-state-ol000000001.json'));
    expect(removeMailLeftovers({ agents, trains })).toEqual({ accounts: 0, files: 0 });
    expect(readFileSync(target, 'utf8')).toBe('keep me');
    expect(lstatSync(join(state, 'gmail-state-gm000000001.json')).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(state, 'outlook-state-ol000000001.json')).isDirectory()).toBe(true);
  });

  test('an unreadable agent file or missing folders are never fatal', () => {
    writeFileSync(agentFile(), 'not json');
    writeFileSync(join(state, 'gmail-state-gm000000001.json'), '{}');
    expect(removeMailLeftovers({ agents, trains })).toEqual({ accounts: 0, files: 1 });
    expect(readFileSync(agentFile(), 'utf8')).toBe('not json');
    rmSync(root, { recursive: true, force: true });
    expect(removeMailLeftovers({ agents, trains })).toEqual({ accounts: 0, files: 0 });
  });

  test('an agent file the cleanup could not rewrite still loads, without the mail accounts', () => {
    writeAgent([gmail, kept, outlook]);
    const [agent] = loadFileAgents(agents);
    expect(agent?.accounts.map((a) => `${a.station}/${a.id}`)).toEqual(['telegram-bot/tb000000001']);
  });

  test('a stray Gmail or Outlook line still counts as an account line, so it reaches nobody', () => {
    const agent = new Set(['agent000001']);
    expect(eventInScope(agent, 'metro://gmail/gm000000001/thread1')).toBe(false);
    expect(eventInScope(agent, 'metro://outlook/ol000000001/AAQkAD=')).toBe(false);
  });
});
