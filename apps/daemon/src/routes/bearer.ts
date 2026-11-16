import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ApiError } from '@metro-labs/http/api-error';
import { setBearerSessions, type ApiSession } from '@metro-labs/http/api-http';
import { bearerSession, clientId, JwksKeys, jwksUrl, metroKeys, SigningKeys, workosBase, type KeyStore } from '@metro-labs/http/workos-token';
import { errMsg, log } from '@metro-labs/core/log';
import { ensureSecureDir, writeSecure } from '@metro-labs/core/secure-fs';

const WORKOS_KEYS_FILE = '.jwks';
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

export function bearerSessionsFor(owner: () => string | null, keys: SigningKeys): (req: Parameters<typeof bearerSession>[0]) => Promise<ApiSession | null> {
  return async (req) => {
    const session = await bearerSession(req, keys);
    if (session === null) return null;
    const held = owner();
    if (held === null || session.organization === null || session.organization !== held)
      throw new ApiError('this machine belongs to another organization', 403);
    return { subject: held, userId: session.userId, sessionId: session.sessionId, role: session.role === 'admin' ? 'admin' : 'member' };
  };
}

export function boxSigningKeys(dir: string, env: NodeJS.ProcessEnv = process.env): SigningKeys {
  const metro = metroKeys(env, jwksStore(dir, METRO_KEYS_FILE));
  metro.refresh().catch((err: unknown) => {
    log.info({ err: errMsg(err) }, 'bearer: the Metro sign-in keys were not fetched at boot, the cached set is kept');
  });
  return new SigningKeys(new JwksKeys(jwksUrl(clientId(env), workosBase(env)), jwksStore(dir, WORKOS_KEYS_FILE)), metro);
}

export function installBearerSessions(dir: string, owner: () => string | null, env: NodeJS.ProcessEnv = process.env): void {
  setBearerSessions(bearerSessionsFor(owner, boxSigningKeys(dir, env)));
}
