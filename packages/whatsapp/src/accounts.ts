import {
  makeAccountStore,
  resolveAccountId,
  type Die,
} from '@metro-labs/core/stations/account-store';
import type { WhatsAppAccount } from './types.js';

const isJid = (s: string): boolean => s.includes('@');

function validateAccount(a: WhatsAppAccount, die: Die): void {
  if (!a.phone || typeof a.phone !== 'string')
    die(`account '${a.id}' missing phone`);
}

export const { loadAccounts } = makeAccountStore<WhatsAppAccount>({
  prefix: 'whatsapp',
  validate(raw, die) {
    for (const a of raw) validateAccount(a, die);
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

export function targetOf(line: string): Target | undefined {
  const prefix = 'metro://whatsapp/';
  if (!line.startsWith(prefix)) return undefined;
  const path = line.slice(prefix.length).split('/').filter(Boolean);
  const [accountId, jid] = path;
  if (path.length !== 2 || accountId === undefined || jid === undefined) return undefined;
  if (!isJid(jid)) return undefined;
  return { accountId, jid };
}
