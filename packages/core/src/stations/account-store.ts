import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { errMsg } from '../log.js';
import { chmodIfExists } from '../secure-fs.js';

export type Die = (msg: string) => never;

export interface AccountStoreOpts<T> {
  prefix: string;
  validate?: (raw: T[], die: Die) => void;
}

export interface Loader<T> {
  die: Die;
  loadAccounts: () => T[];
}

const envName = (prefix: string): string =>
  `${prefix.toUpperCase().replace(/-/g, '_')}_ACCOUNTS_FILE`;

const accountsFile = (prefix: string): string =>
  process.env[envName(prefix)] ?? join(homedir(), '.metro', `${prefix}-accounts.json`);

function checkIds(raw: { id?: unknown }[], die: Die): void {
  const seen = new Set<unknown>();
  for (const a of raw) {
    if (!a.id) die('account missing id');
    if (seen.has(a.id)) die(`duplicate account id '${String(a.id)}'`);
    seen.add(a.id);
  }
}

function readList<T>(file: string, die: Die): T[] {
  if (!existsSync(file))
    return die(
      `no accounts file ${file} — the daemon writes it from ~/.metro/agents/agent.json at boot; attach an account to this station from the page first`,
    );
  chmodIfExists(file);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    return die(`bad ${file}: ${errMsg(e)}`);
  }
  if (!Array.isArray(raw) || raw.length === 0)
    return die(`${file} must be a non-empty array`);
  return raw as T[];
}

export function makeAccountStore<T extends { id: string }>(
  opts: AccountStoreOpts<T>,
): Loader<T> {
  const die: Die = (msg) => {
    process.stderr.write(`${opts.prefix}: ${msg}\n`);
    process.exit(2);
  };

  function loadAccounts(): T[] {
    const raw = readList<T>(accountsFile(opts.prefix), die);
    checkIds(raw, die);
    opts.validate?.(raw, die);
    return raw;
  }

  return { die, loadAccounts };
}

export function resolveAccountId(
  accounts: Map<string, unknown>,
  args: { account?: string; line?: string },
  parseAccountId: (line: string) => string | undefined,
): string {
  const have = [...accounts.keys()];
  let id = args.account;
  id ??= args.line ? parseAccountId(args.line) : undefined;
  id ??= have.length === 1 ? have[0] : undefined;
  if (id === undefined)
    throw new Error(`name an account (have: ${have.join(', ')})`);
  if (!accounts.has(id))
    throw new Error(`unknown account '${id}' (have: ${have.join(', ')})`);
  return id;
}
