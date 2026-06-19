/** Shared daemon account-loader: read a per-station accounts JSON file, validate,
 *  apply an allowlist, with a single-account env fallback. Factored out of the
 *  near-identical discord/telegram/xmtp loadAccounts (validate/fallback injected). */

import { existsSync, readFileSync } from 'node:fs';
import { chmodIfExists } from '../secure-fs.js';

/** `die(msg)` - write `<prefix>: <msg>` to stderr and exit(2). */
export type Die = (msg: string) => never;

export interface MakeLoaderOpts<T> {
  /** Station label used in stderr diagnostics, e.g. 'discord'. */
  prefix: string;
  /** Resolved path to the accounts JSON file. */
  file: string;
  /** Env-var names whose comma-list (first set wins) restricts which ids load. */
  allowlistEnv: string[];
  /** Station-specific validation; should `die` on any invalid account. */
  validate: (raw: T[], die: Die) => void;
  /** Single-account fallback when the accounts file is absent. `die` on missing creds. */
  fallback: (die: Die) => T[];
}

export interface Loader<T> {
  /** `<prefix>: <msg>` → stderr + exit(2). Exposed so callers can reuse it. */
  die: Die;
  /** Resolve the account list: file (parse + validate + allowlist) or env fallback. */
  loadAccounts: () => T[];
}

/** Build a station account loader. All accounts carry a string `id`. */
export function makeAccountStore<T extends { id: string }>(opts: MakeLoaderOpts<T>): Loader<T> {
  const die: Die = (msg) => {
    process.stderr.write(`${opts.prefix}: ${msg}\n`);
    process.exit(2);
  };

  // Preserve `<PREFIX>_ONLY_ACCOUNTS ?? <PREFIX>_ACCOUNTS ?? ''` precedence:
  // `??` only falls through on undefined, so an empty-string env var still wins.
  let allowlistRaw: string | undefined;
  for (const k of opts.allowlistEnv) { if (allowlistRaw === undefined) allowlistRaw = process.env[k]; }
  const allowlist = new Set(
    (allowlistRaw ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  );

  function loadAccounts(): T[] {
    if (existsSync(opts.file)) {
      // Harden perms on load: existing creds may predate the 0600 policy
      // (known 0644 leak). MODE only — content is untouched.
      chmodIfExists(opts.file);
      let raw: T[];
      try { raw = JSON.parse(readFileSync(opts.file, 'utf8')) as T[]; }
      catch (e) { return die(`bad ${opts.file}: ${(e as Error).message}`); }
      if (!Array.isArray(raw) || raw.length === 0) die(`${opts.file} must be a non-empty array`);
      opts.validate(raw, die);
      const selected = allowlist.size ? raw.filter((a) => allowlist.has(a.id)) : raw;
      if (selected.length === 0) {
        die(`no accounts match ${opts.allowlistEnv[0]} (${[...allowlist].join(', ')})`);
      }
      return selected;
    }
    return opts.fallback(die);
  }

  return { die, loadAccounts };
}

/** Split a comma-separated env list into trimmed, non-empty items. */
export function csv(raw: string | undefined): string[] {
  return (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

/** Plural-then-singular token env → token list. First non-empty plural var wins
 *  (e.g. DISCORD_BOT_TOKENS=a,b → many bots); else the singular var as a one-item
 *  legacy list; else []. */
export function tokensFromEnv(pluralEnv: string[], singularEnv: string): string[] {
  for (const k of pluralEnv) {
    const list = csv(process.env[k]);
    if (list.length) return list;
  }
  const one = process.env[singularEnv]?.trim();
  return one ? [one] : [];
}

/** Parse HD derive indices from env: XMTP_DERIVE_INDICES (explicit comma list,
 *  wins) or XMTP_DERIVE_COUNT (→ 0..N-1). Deduped non-negative list, or [] when
 *  neither is set. Pure (no xmtp deps) so it's unit testable without the client. */
export function deriveIndices(
  indicesEnv: string | undefined, countEnv: string | undefined, die: Die,
): number[] {
  const explicit = csv(indicesEnv);
  if (explicit.length) {
    const idx = explicit.map((s) => Number(s));
    for (const n of idx) {
      if (!Number.isInteger(n) || n < 0) die(`XMTP_DERIVE_INDICES must be non-negative integers (got '${indicesEnv}')`);
    }
    if (new Set(idx).size !== idx.length) die('XMTP_DERIVE_INDICES has a duplicate index');
    return idx;
  }
  const raw = countEnv?.trim();
  if (raw) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) die(`XMTP_DERIVE_COUNT must be a positive integer (got '${raw}')`);
    return Array.from({ length: n }, (_, i) => i);
  }
  return [];
}

/** Build ids for a token list: explicit `idsEnv` (comma list) wins position-wise;
 *  else single token keeps `default`, N tokens get `<prefix>0..N-1`. `die`s on a
 *  duplicate or short id list. */
export function idsFor(
  prefix: string, count: number, idsEnv: string | undefined, die: Die,
): string[] {
  const explicit = csv(idsEnv);
  if (explicit.length) {
    if (explicit.length < count) die(`${count} tokens but only ${explicit.length} ids`);
    const ids = explicit.slice(0, count);
    if (new Set(ids).size !== ids.length) die(`duplicate id in list (${ids.join(', ')})`);
    return ids;
  }
  if (count === 1) return ['default'];
  return Array.from({ length: count }, (_, i) => `${prefix}${i}`);
}
