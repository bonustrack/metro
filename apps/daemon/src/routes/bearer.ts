import { existsSync, lstatSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { ApiError } from '@metro-labs/http/api-error';
import { setBearerSessions, type ApiSession } from '@metro-labs/http/api-http';
import { bearerSession, metroKeys, type KeySource, type KeyStore } from '@metro-labs/http/user-token';
import { errMsg, log } from '@metro-labs/core/log';
import { ensureSecureDir, writeSecure } from '@metro-labs/core/secure-fs';

const OLD_WORKOS_KEYS_FILE = '.jwks';
const METRO_KEYS_FILE = '.jwks-metro';

function jwksStore(dir: string, file: string): KeyStore {
  const path = join(dir, file);
  return {
    read: () => (existsSync(path) ? readFileSync(path, 'utf8') : null),
    write: (text) => {
      ensureSecureDir(dir);
      writeSecure(path, text);
    },
  };
}

const codeOf = (err: unknown): unknown => (err instanceof Error && 'code' in err ? err.code : undefined);

export function removeOldKeyCache(dir: string): boolean {
  const path = join(dir, OLD_WORKOS_KEYS_FILE);
  try {
    if (!lstatSync(path).isFile()) {
      log.warn({ path }, 'bearer: left the old sign-in key cache alone, it is not a regular file');
      return false;
    }
    unlinkSync(path);
    log.info({ path }, 'bearer: removed the old WorkOS sign-in key cache');
    return true;
  } catch (err) {
    if (codeOf(err) !== 'ENOENT') log.warn({ err: errMsg(err), path }, 'bearer: could not remove the old WorkOS sign-in key cache');
    return false;
  }
}

export function bearerSessionsFor(owner: () => string | null, keys: KeySource): (req: Parameters<typeof bearerSession>[0]) => Promise<ApiSession | null> {
  return async (req) => {
    const session = await bearerSession(req, keys);
    if (session === null) return null;
    const held = owner();
    if (held === null || session.organization === null || session.organization !== held)
      throw new ApiError('this machine belongs to another organization', 403);
    return { subject: held, userId: session.userId, sessionId: session.sessionId, role: session.role === 'admin' ? 'admin' : 'member' };
  };
}

export function boxSigningKeys(dir: string, env: NodeJS.ProcessEnv = process.env): KeySource {
  const metro = metroKeys(env, jwksStore(dir, METRO_KEYS_FILE));
  metro.refresh().catch((err: unknown) => {
    log.info({ err: errMsg(err) }, 'bearer: the Metro sign-in keys were not fetched at boot, the cached set is kept');
  });
  return metro;
}

export function installBearerSessions(dir: string, owner: () => string | null, env: NodeJS.ProcessEnv = process.env): void {
  removeOldKeyCache(dir);
  setBearerSessions(bearerSessionsFor(owner, boxSigningKeys(dir, env)));
}
