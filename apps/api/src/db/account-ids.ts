import { createHash, randomBytes } from 'node:crypto';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_CHARS = 10;
const RANDOM_BYTES = 10;
const BASE = 32;
const BITS = 5;
const MASK = 31;

type AccountIdPrefix = 'user' | 'om' | 'session' | 'link' | 'org';

export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function timePart(now: number): string {
  let out = '';
  let rest = Math.floor(now);
  for (let i = 0; i < TIME_CHARS; i += 1) {
    out = `${CROCKFORD.charAt(rest % BASE)}${out}`;
    rest = Math.floor(rest / BASE);
  }
  return out;
}

function randomPart(): string {
  let out = '';
  let value = 0;
  let bits = 0;
  for (const byte of randomBytes(RANDOM_BYTES)) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= BITS) {
      bits -= BITS;
      out += CROCKFORD.charAt((value >> bits) & MASK);
    }
    value &= (1 << bits) - 1;
  }
  return out;
}

export const accountId = (prefix: AccountIdPrefix, now = Date.now()): string => `${prefix}_${timePart(now)}${randomPart()}`;

export const secretHashOf = (secret: string): string => createHash('sha256').update(secret, 'utf8').digest('base64url');

export const newSecret = (): string => randomBytes(32).toString('base64url');
