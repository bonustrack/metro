import { existsSync, readFileSync } from 'node:fs';
import { errMsg } from '../log.js';
import { chmodIfExists } from '../secure-fs.js';

export type Die = (msg: string) => never;

export interface MakeLoaderOpts<T> {
  prefix: string;
  file: string;
  validate: (raw: T[], die: Die) => void;
}

export interface Loader<T> {
  die: Die;
  loadAccounts: () => T[];
}

export function makeAccountStore<T extends { id: string }>(
  opts: MakeLoaderOpts<T>,
): Loader<T> {
  const die: Die = (msg) => {
    process.stderr.write(`${opts.prefix}: ${msg}\n`);
    process.exit(2);
  };

  function loadAccounts(): T[] {
    if (!existsSync(opts.file))
      return die(
        `no accounts file ${opts.file} — the daemon writes it from ~/.metro/agents/agent.json at boot; attach an account to this station from the page first`,
      );
    chmodIfExists(opts.file);
    let raw: T[];
    try {
      raw = JSON.parse(readFileSync(opts.file, 'utf8')) as T[];
    } catch (e) {
      return die(`bad ${opts.file}: ${errMsg(e)}`);
    }
    if (!Array.isArray(raw) || raw.length === 0)
      die(`${opts.file} must be a non-empty array`);
    opts.validate(raw, die);
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
