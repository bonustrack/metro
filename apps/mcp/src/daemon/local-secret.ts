import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentsDir } from '../db/file-source.js';
import { ensureSecureDir, writeSecure } from './secure-fs.js';

const SECRET_FILE = '.session-secret';

export function ensureLocalSessionSecret(dir = agentsDir()): string {
  const configured = process.env.METRO_SESSION_SECRET?.trim() ?? '';
  if (configured !== '') return configured;
  const path = join(dir, SECRET_FILE);
  let secret = existsSync(path) ? readFileSync(path, 'utf8').trim() : '';
  if (secret === '') {
    secret = randomBytes(32).toString('base64url');
    ensureSecureDir(dir);
    writeSecure(path, `${secret}\n`);
  }
  process.env.METRO_SESSION_SECRET = secret;
  return secret;
}
