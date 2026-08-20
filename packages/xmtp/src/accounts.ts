import {
  Client,
  type ClientOptions,
  type Conversation,
} from '@xmtp/node-sdk';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CODECS } from './codecs.js';
import { expandHome, signerFor, XMTP_ENV } from './identity.js';
import {
  makeAccountStore,
  resolveAccountId,
} from '@metro-labs/mcp/stations/account-store';
import { Line } from '@metro-labs/mcp/lines';

const ACCOUNTS_FILE =
  process.env.XMTP_ACCOUNTS_FILE ??
  join(homedir(), '.metro', 'xmtp-accounts.json');

export interface AccountConfig {
  id: string;
  privateKey?: string;
  owner?: string;
  dbPath?: string;
}

export const { loadAccounts } = makeAccountStore<AccountConfig>({
  prefix: 'xmtp',
  file: ACCOUNTS_FILE,
  allowlistEnv: ['XMTP_ONLY_ACCOUNTS', 'XMTP_ACCOUNTS'],
  validate(raw, die) {
    const seen = new Set<string>();
    for (const a of raw) {
      if (!a.id) die('account missing id');
      if (!a.privateKey) die(`account '${a.id}' needs a privateKey`);
      if (seen.has(a.id)) die(`duplicate account id '${a.id}'`);
      seen.add(a.id);
    }
  },
});

function resolvePrivateKey(cfg: AccountConfig): string {
  const privateKey = cfg.privateKey?.trim();
  if (!privateKey) throw new Error(`account '${cfg.id}' has no privateKey`);
  return privateKey;
}

export interface Account {
  cfg: AccountConfig;
  client: Client<unknown>;
  inboxId: string;
  address: string;
}
export const accounts = new Map<string, Account>();

export async function bootAccount(cfg: AccountConfig): Promise<void> {
  const { signer, address } = signerFor(resolvePrivateKey(cfg));
  const dbPath = expandHome(
    cfg.dbPath ?? join(homedir(), '.metro', `xmtp-${XMTP_ENV}-${cfg.id}.db3`),
  );
  const options: ClientOptions = { env: XMTP_ENV, codecs: CODECS(), dbPath };
  const client: Client<unknown> = await Client.create(signer, options);
  accounts.set(cfg.id, { cfg, client, inboxId: client.inboxId, address });
  process.stderr.write(
    `xmtp[${cfg.id}] ready — inbox ${client.inboxId} (${address}, owner=${cfg.owner ?? '(broadcast)'})\n`,
  );
}

export function lineOf(accountId: string, convId: string): string {
  return `metro://xmtp/${accountId}/${convId}`;
}

export function parseLine(
  line: string,
): { accountId: string; convId: string } | null {
  const p = Line.parseXmtp(line);
  return p ? { accountId: p.accountId, convId: p.resource } : null;
}

export function accountForCall(args: {
  account?: string;
  line?: string;
}): Account {
  const id = resolveAccountId(
    accounts,
    args,
    (line) => parseLine(line)?.accountId,
  );
  const acct = accounts.get(id);
  if (!acct) throw new Error(`unknown account '${id}'`);
  return acct;
}

export async function convOf(
  line: string,
): Promise<{ acct: Account; conv: Conversation | undefined }> {
  const parsed = parseLine(line);
  if (!parsed) throw new Error(`bad xmtp line: ${line}`);
  const acct = accounts.get(parsed.accountId);
  if (!acct)
    throw new Error(`unknown account '${parsed.accountId}' in line ${line}`);
  return {
    acct,
    conv: await acct.client.conversations.getConversationById(parsed.convId),
  };
}
