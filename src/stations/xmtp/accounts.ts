/** XMTP multi-account config, key resolution, client boot, and line routing. */

import { Client, IdentifierKind, type Conversation, type Signer } from '@xmtp/node-sdk';
import { privateKeyToAccount, mnemonicToAccount } from 'viem/accounts';
import { toHex } from 'viem';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CODECS } from './codecs.js';
import { makeAccountStore } from '../account-store.js';
import { Line } from '../../lines.js';

const ACCOUNTS_FILE = process.env.XMTP_ACCOUNTS_FILE ?? join(homedir(), '.metro', 'xmtp-accounts.json');

// Identity is ALWAYS an HD account derived from MNEMONIC (m/44'/60'/0'/0/<index>),
// on the production XMTP network.
const XMTP_ENV = 'production' as const;

export interface AccountConfig {
  id: string;
  /** HD index into the MNEMONIC: m/44'/60'/0'/0/<derive>. */
  derive: number;
  /** Default `to` for this account's inbound events → feed isolation. */
  owner?: string;
  /** node-sdk local MLS db; defaults to per-account path. */
  dbPath?: string;
}

export const { die, loadAccounts } = makeAccountStore<AccountConfig>({
  prefix: 'xmtp',
  file: ACCOUNTS_FILE,
  allowlistEnv: ['XMTP_ONLY_ACCOUNTS', 'XMTP_ACCOUNTS'],
  validate(raw, die) {
    const seen = new Set<string>();
    for (const a of raw) {
      if (!a.id) die('account missing id');
      if (typeof a.derive !== 'number' || a.derive < 0 || !Number.isInteger(a.derive)) {
        die(`account '${a.id}' derive must be a non-negative integer`);
      }
      if (seen.has(a.id)) die(`duplicate account id '${a.id}'`);
      seen.add(a.id);
    }
  },
  /** Env fallback (no accounts file): derive indices 0..DERIVE_COUNT-1 (default 1)
   *  from the MNEMONIC. Ids are x<index> (path m/44'/60'/0'/0/<index>). */
  fallback(die) {
    const raw = process.env.DERIVE_COUNT?.trim();
    const n = raw ? Number(raw) : 1;
    if (!Number.isInteger(n) || n <= 0) die(`DERIVE_COUNT must be a positive integer (got '${raw}')`);
    return Array.from({ length: n }, (_, i) => ({ id: `x${i}`, derive: i }));
  },
});

let cachedMnemonic: string | null = null;
function loadMnemonic(): string {
  if (cachedMnemonic) return cachedMnemonic;
  const m = process.env.MNEMONIC?.trim();
  if (!m) die('MNEMONIC unset (identity derives from a BIP-39 mnemonic)');
  cachedMnemonic = m;
  return m;
}

/** Resolve an account's raw 0x private key by HD-deriving from the MNEMONIC. */
function resolvePrivateKey(cfg: AccountConfig): string {
  const acct = mnemonicToAccount(loadMnemonic(), { addressIndex: cfg.derive });
  return toHex(acct.getHdKey().privateKey!); // HD path m/44'/60'/0'/0/<derive>
}

// Set XMTP_LEGACY_DEFAULT_LINES=1 to keep the default account emitting legacy
// metro://xmtp/<conv> lines (zero migration for existing claims/deep-links).
const LEGACY_DEFAULT_LINES = process.env.XMTP_LEGACY_DEFAULT_LINES === '1';

const expandHome = (p: string): string => p.startsWith('~') ? join(homedir(), p.slice(1)) : p;

export interface Account {
  cfg: AccountConfig;
  client: Client;
  inboxId: string;
  address: string;
}
export const accounts = new Map<string, Account>();

function signerFor(privateKey: string): { signer: Signer; address: string } {
  const acct = privateKeyToAccount(privateKey as `0x${string}`);
  const signer: Signer = {
    type: 'EOA',
    getIdentifier: async () => ({ identifier: acct.address, identifierKind: IdentifierKind.Ethereum }),
    signMessage: async (msg: string) => {
      const sig = await acct.signMessage({ message: msg });
      const hex = sig.slice(2);
      const out = new Uint8Array(hex.length / 2);
      for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
      return out;
    },
  };
  return { signer, address: acct.address };
}

export async function bootAccount(cfg: AccountConfig): Promise<void> {
  const { signer, address } = signerFor(resolvePrivateKey(cfg));
  const dbPath = expandHome(cfg.dbPath ?? join(homedir(), '.metro', `xmtp-${XMTP_ENV}-${cfg.id}.db3`));
  const client = await Client.create(signer, { env: XMTP_ENV, codecs: CODECS(), dbPath });
  accounts.set(cfg.id, { cfg, client, inboxId: client.inboxId, address });
  process.stderr.write(
    `xmtp[${cfg.id}] ready — inbox ${client.inboxId} (${address}, owner=${cfg.owner ?? '(broadcast)'})\n`);
}

/** Per-account line. The default account may emit legacy lines for migration. */
export function lineOf(accountId: string, convId: string): string {
  if (accountId === 'default' && LEGACY_DEFAULT_LINES) return `metro://xmtp/${convId}`;
  return `metro://xmtp/${accountId}/${convId}`;
}

/** Parse a line back to {accountId, convId}. Accepts new + legacy forms.
 *  Delegates to the canonical `Line.parseXmtp` (single source of truth for the
 *  metro:// scheme); convId is the account-scoped `resource` segment. */
export function parseLine(line: string): { accountId: string; convId: string } | null {
  const p = Line.parseXmtp(line);
  return p ? { accountId: p.accountId, convId: p.resource } : null;
}

export function accountForCall(args: { account?: string; line?: string }): Account {
  let id = args.account;
  if (!id && args.line) id = parseLine(args.line)?.accountId;
  if (!id) id = accounts.size === 1 ? [...accounts.keys()][0] : 'default';
  const acct = accounts.get(id);
  if (!acct) throw new Error(`unknown account '${id}' (have: ${[...accounts.keys()].join(', ')})`);
  return acct;
}

export async function convOf(line: string): Promise<{ acct: Account; conv: Conversation | undefined }> {
  const parsed = parseLine(line);
  if (!parsed) throw new Error(`bad xmtp line: ${line}`);
  const acct = accounts.get(parsed.accountId);
  if (!acct) throw new Error(`unknown account '${parsed.accountId}' in line ${line}`);
  return { acct, conv: await acct.client.conversations.getConversationById(parsed.convId) };
}
