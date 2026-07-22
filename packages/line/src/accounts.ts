import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  makeAccountStore,
  resolveAccountId,
  type Die,
} from '@metro-labs/mcp/stations/account-store';
import type { LineAccount } from './types.js';

function accountsFilePath(): string {
  return (
    process.env.LINE_ACCOUNTS_FILE ??
    join(homedir(), '.metro', 'line-accounts.json')
  );
}

const ACCOUNTS_FILE = accountsFilePath();

const isSourceId = (s: string): boolean => /^[URCS][0-9a-f]{32}$/i.test(s);

function validateAccount(a: LineAccount, seen: Set<string>, die: Die): void {
  if (!a.id) die('account missing id');
  if (!a.channelAccessToken || typeof a.channelAccessToken !== 'string')
    die(`account '${a.id}' missing channelAccessToken`);
  if (!a.channelSecret || typeof a.channelSecret !== 'string')
    die(`account '${a.id}' missing channelSecret`);
  if (seen.has(a.id)) die(`duplicate account id '${a.id}'`);
  seen.add(a.id);
}

export const { loadAccounts } = makeAccountStore<LineAccount>({
  prefix: 'line',
  file: ACCOUNTS_FILE,
  allowlistEnv: ['LINE_ONLY_ACCOUNTS', 'LINE_ACCOUNTS'],
  validate(raw, die) {
    const seen = new Set<string>();
    for (const a of raw) validateAccount(a, seen, die);
  },
});

export function readAccountsFile(): LineAccount[] {
  const file = accountsFilePath();
  if (!existsSync(file)) return [];
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as LineAccount[];
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

export const accounts = new Map<string, LineAccount>();

export function accountFor(args: { account?: string; line?: string }): string {
  return resolveAccountId(accounts, args, (line) => targetOf(line)?.accountId);
}

export function lineOf(accountId: string, sourceId: string): string {
  return `metro://line/${accountId}/${sourceId}`;
}

interface Target {
  accountId: string;
  sourceId: string;
}

function splitScoped(path: string[]): { accountId: string; sourceId?: string } {
  const first = path[0];
  if (path.length >= 2 && first !== undefined && !isSourceId(first))
    return { accountId: first, sourceId: path[1] };
  return { accountId: 'default', sourceId: first };
}

export function targetOf(line: string): Target | undefined {
  const prefix = 'metro://line/';
  if (!line.startsWith(prefix)) return undefined;
  const path = line.slice(prefix.length).split('/').filter(Boolean);
  const { accountId, sourceId } = splitScoped(path);
  if (sourceId === undefined || !isSourceId(sourceId)) return undefined;
  return { accountId, sourceId };
}
