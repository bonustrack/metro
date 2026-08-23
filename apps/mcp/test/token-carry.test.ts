import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tokenStorePath } from '@metro-labs/whatsapp/tokens';
import { carryTokenStores, type CarriedStation } from '../src/db/token-carry.ts';

const OLD = 'w0';
const NEW = 'kJ8x2mQvR1p';
const TOKENS = JSON.stringify({
  tctoken: { '66627299915@s.whatsapp.net': { token: 'tc-abc' } },
  'lid-mapping': { '66627299915': '12345@lid' },
});

let dir = '';
let saved: string | undefined;

const row = (over: Partial<CarriedStation> = {}): CarriedStation => ({
  station: 'whatsapp',
  id: NEW,
  config: { previousAccountId: OLD },
  ...over,
});

const seed = (accountId: string): string => {
  const path = tokenStorePath(accountId);
  writeFileSync(path, TOKENS, { mode: 0o600 });
  return path;
};

beforeEach(() => {
  saved = process.env.WHATSAPP_TOKEN_DIR;
  dir = mkdtempSync(join(tmpdir(), 'metro-token-carry-'));
  process.env.WHATSAPP_TOKEN_DIR = dir;
});

afterEach(() => {
  if (saved === undefined) delete process.env.WHATSAPP_TOKEN_DIR;
  else process.env.WHATSAPP_TOKEN_DIR = saved;
  rmSync(dir, { recursive: true, force: true });
});

describe('carrying the whatsapp token store to the station id', () => {
  test('the tctoken store survives the id change — this is what stops a 463', () => {
    seed(OLD);
    expect(carryTokenStores([row()])).toBe(1);
    expect(readFileSync(tokenStorePath(NEW), 'utf8')).toBe(TOKENS);
  });

  test('it copies, never moves — the running train still reads the old name', () => {
    const from = seed(OLD);
    carryTokenStores([row()]);
    expect(existsSync(from)).toBe(true);
  });

  test('the copy is 0600 — copyFileSync would have widened it', () => {
    seed(OLD);
    carryTokenStores([row()]);
    expect(statSync(tokenStorePath(NEW)).mode & 0o777).toBe(0o600);
  });

  test('it lands on exactly the path the train will read', () => {
    seed(OLD);
    carryTokenStores([row()]);
    expect(existsSync(join(dir, `whatsapp-tokens-${NEW}.json`))).toBe(true);
  });

  test('an existing destination is never overwritten', () => {
    seed(OLD);
    writeFileSync(tokenStorePath(NEW), '{"tctoken":{"newer":{}}}', { mode: 0o600 });
    expect(carryTokenStores([row()])).toBe(0);
    expect(readFileSync(tokenStorePath(NEW), 'utf8')).toBe('{"tctoken":{"newer":{}}}');
  });

  test('no source file is a no-op, not a throw — boot must not depend on it', () => {
    expect(carryTokenStores([row()])).toBe(0);
    expect(existsSync(tokenStorePath(NEW))).toBe(false);
  });

  test('only whatsapp carries state keyed by the account id', () => {
    seed(OLD);
    expect(carryTokenStores([row({ station: 'xmtp' })])).toBe(0);
    expect(carryTokenStores([row({ station: 'telegram-bot' })])).toBe(0);
  });

  test('a row whose id already equals its previous account id is skipped', () => {
    seed(OLD);
    expect(carryTokenStores([row({ id: OLD, config: { previousAccountId: OLD } })])).toBe(0);
  });

  test('a row with no stashed previous id is skipped — nothing to carry from', () => {
    seed(OLD);
    expect(carryTokenStores([row({ config: {} })])).toBe(0);
    expect(existsSync(tokenStorePath(NEW))).toBe(false);
  });

  test('a non-string stash is ignored rather than trusted', () => {
    seed(OLD);
    expect(carryTokenStores([row({ config: { previousAccountId: 42 } })])).toBe(0);
  });

  test('running it twice carries once — release 1 boots more than once', () => {
    seed(OLD);
    expect(carryTokenStores([row()])).toBe(1);
    expect(carryTokenStores([row()])).toBe(0);
  });
});
