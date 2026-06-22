import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { log } from './log.js';
import { STATE_DIR } from './paths.js';
import { Line } from './lines.js';

export const CLAIMS_FILE = join(STATE_DIR, 'claims.json');

export type ClaimsMap = Record<string, Line>;

export function readClaims(): ClaimsMap {
  if (!existsSync(CLAIMS_FILE)) return {};
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return JSON.parse(readFileSync(CLAIMS_FILE, 'utf8')) as ClaimsMap;
    } catch {
    }
  }
  log.warn({ path: CLAIMS_FILE }, 'claims: malformed, treating as empty');
  return {};
}
