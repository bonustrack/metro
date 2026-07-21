import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  makeAccountStore,
  resolveAccountId,
  type Die,
} from '@metro-labs/mcp/stations/account-store';
import type { WhatsAppAccount } from './types.js';

const ACCOUNTS_FILE =
  process.env.WHATSAPP_ACCOUNTS_FILE ??
  join(homedir(), '.metro', 'whatsapp-accounts.json');

const isJid = (s: string): boolean => s.includes('@');

function validateAccount(
  a: WhatsAppAccount,
  seen: Set<string>,
  die: Die,
): void {
  if (!a.id) die('account missing id');
  if (!a.phone || typeof a.phone !== 'string')
    die(`account '${a.id}' missing phone`);
  if (seen.has(a.id)) die(`duplicate account id '${a.id}'`);
  seen.add(a.id);
}

export const { loadAccounts } = makeAccountStore<WhatsAppAccount>({
  prefix: 'whatsapp',
  file: ACCOUNTS_FILE,
  allowlistEnv: ['WHATSAPP_ONLY_ACCOUNTS', 'WHATSAPP_ACCOUNTS'],
  validate(raw, die) {
    const seen = new Set<string>();
    for (const a of raw) validateAccount(a, seen, die);
  },
});

export const accounts = new Map<string, WhatsAppAccount>();

export function accountFor(args: { account?: string; line?: string }): string {
  return resolveAccountId(accounts, args, (line) => targetOf(line)?.accountId);
}

export function lineOf(accountId: string, jid: string): string {
  return `metro://whatsapp/${accountId}/${jid}`;
}

interface Target {
  accountId: string;
  jid: string;
}

function splitScoped(path: string[]): { accountId: string; jid?: string } {
  const first = path[0];
  if (path.length >= 2 && first !== undefined && !isJid(first))
    return { accountId: first, jid: path[1] };
  return { accountId: 'default', jid: first };
}

export function targetOf(line: string): Target | undefined {
  const prefix = 'metro://whatsapp/';
  if (!line.startsWith(prefix)) return undefined;
  const path = line.slice(prefix.length).split('/').filter(Boolean);
  const { accountId, jid } = splitScoped(path);
  if (jid === undefined || !isJid(jid)) return undefined;
  return { accountId, jid };
}
