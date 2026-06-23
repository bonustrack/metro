import { existsSync, readFileSync } from 'node:fs';
import { errMsg } from '../log.js';
import { chmodIfExists } from '../secure-fs.js';

export type Die = (msg: string) => never;

export interface MakeLoaderOpts<T> {
  prefix: string;
  file: string;
  allowlistEnv: string[];
  validate: (raw: T[], die: Die) => void;
  fallback: (die: Die) => T[];
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

  let allowlistRaw: string | undefined;
  for (const k of opts.allowlistEnv) {
    allowlistRaw ??= process.env[k];
  }
  const allowlist = new Set(
    (allowlistRaw ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

  function loadAccounts(): T[] {
    if (existsSync(opts.file)) {
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
      const selected = allowlist.size
        ? raw.filter((a) => allowlist.has(a.id))
        : raw;
      if (selected.length === 0) {
        die(
          `no accounts match ${opts.allowlistEnv[0]} (${[...allowlist].join(', ')})`,
        );
      }
      return selected;
    }
    return opts.fallback(die);
  }

  return { die, loadAccounts };
}

export function csv(raw: string | undefined): string[] {
  return [
    ...new Set(
      (raw ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
}

export function genIds(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix}${i}`);
}
