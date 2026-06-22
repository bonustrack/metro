import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { log } from './log.js';
import { STATE_DIR } from './paths.js';
import { Line } from './lines.js';

export const CLAIMS_FILE = join(STATE_DIR, 'claims.json');
const CLAIMS_LOCK = join(STATE_DIR, 'claims.json.lock');

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

function withClaimsLock<T>(fn: (m: ClaimsMap) => T): T {
  const deadline = Date.now() + 2_000;
  while (true) {
    try {
      closeSync(openSync(CLAIMS_LOCK, 'wx'));
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      if (Date.now() > deadline)
        throw new Error('claims.json: lock contention (held >2s)');
    }
  }
  try {
    const next = readClaims();
    const result = fn(next);
    const tmp = `${CLAIMS_FILE}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
    renameSync(tmp, CLAIMS_FILE);
    return result;
  } finally {
    try {
      unlinkSync(CLAIMS_LOCK);
    } catch {
    }
  }
}

export function claimLine(line: Line, owner: Line): ClaimsMap {
  return withClaimsLock((m) => {
    m[line] = owner;
    return m;
  });
}

export function releaseLine(line: Line): {
  released: boolean;
  claims: ClaimsMap;
} {
  return withClaimsLock((m) => {
    const released = line in m;
    const next: ClaimsMap = {};
    for (const [k, v] of Object.entries(m)) if (k !== line) next[k] = v;
    return { released, claims: next };
  });
}
