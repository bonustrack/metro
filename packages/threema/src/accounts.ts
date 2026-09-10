import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  makeAccountStore,
  resolveAccountId,
  type Die,
} from '@metro-labs/core/stations/account-store';
import { Line } from '@metro-labs/core/lines';
import { fetchPublicKey } from './api.js';
import { hexToBytes, keyPairFrom, type KeyPair } from './crypto.js';
import { isGatewayId, normalizeThreemaId, parsePrivateKey } from './ids.js';

const ACCOUNTS_FILE =
  process.env.THREEMA_ACCOUNTS_FILE ??
  join(homedir(), '.metro', 'threema-accounts.json');

export interface AccountConfig {
  id: string;
  gatewayId: string;
  secret: string;
  privateKey: string;
  callbackId?: string;
  callbackToken?: string;
  owner?: string;
}

function checkAccount(a: AccountConfig, die: Die): void {
  if (!a.id) die('account missing id');
  if (typeof a.gatewayId !== 'string' || !isGatewayId(a.gatewayId))
    die(`account '${a.id}' has no Gateway ID`);
  if (typeof a.secret !== 'string' || a.secret === '')
    die(`account '${a.id}' missing secret`);
  if (typeof a.privateKey !== 'string' || parsePrivateKey(a.privateKey) === null)
    die(`account '${a.id}' has no usable private key`);
}

export const { loadAccounts } = makeAccountStore<AccountConfig>({
  prefix: 'threema',
  file: ACCOUNTS_FILE,
  validate(raw, die) {
    const seenId = new Set<string>();
    const seenGateway = new Set<string>();
    for (const a of raw) {
      checkAccount(a, die);
      if (seenId.has(a.id)) die(`duplicate account id '${a.id}'`);
      if (seenGateway.has(a.gatewayId))
        die(`account '${a.id}' reuses the Gateway ID of another account`);
      seenId.add(a.id);
      seenGateway.add(a.gatewayId);
    }
  },
});

export interface Account {
  cfg: AccountConfig;
  keys: KeyPair;
  publicKeys: Map<string, Uint8Array>;
}

export const accounts = new Map<string, Account>();

export function bootAccount(cfg: AccountConfig): Account {
  const key = parsePrivateKey(cfg.privateKey);
  if (key === null) throw new Error(`account '${cfg.id}' has no usable private key`);
  return { cfg, keys: keyPairFrom(key), publicKeys: new Map() };
}

export function accountFor(id: string): Account {
  const acct = accounts.get(id);
  if (!acct)
    throw new Error(
      `unknown account '${id}' (have: ${[...accounts.keys()].join(', ')})`,
    );
  return acct;
}

export function targetOf(
  line: string,
  account?: string,
): { acct: Account; to: string } {
  const parsed = Line.parseThreema(line);
  if (parsed === null) throw new Error(`not a threema line: ${line}`);
  const id = resolveAccountId(
    accounts,
    { account, line },
    (l) => Line.parseThreema(l)?.accountId,
  );
  return { acct: accountFor(id), to: normalizeThreemaId(parsed.resource) };
}

export async function publicKeyFor(
  acct: Account,
  threemaId: string,
): Promise<Uint8Array> {
  const cached = acct.publicKeys.get(threemaId);
  if (cached) return cached;
  const key = hexToBytes(await fetchPublicKey(acct.cfg, threemaId), 'public key');
  acct.publicKeys.set(threemaId, key);
  return key;
}
