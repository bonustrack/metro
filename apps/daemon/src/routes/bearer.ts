import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ApiError } from '@metro-labs/http/api-error';
import { setBearerSessions, type ApiSession } from '@metro-labs/http/api-http';
import { bearerSession, clientId, jwksUrl, SigningKeys, workosBase, type KeyStore } from '@metro-labs/http/workos-token';
import { ensureSecureDir, writeSecure } from '@metro-labs/core/secure-fs';

const KEYS_FILE = '.jwks';

export function jwksStore(dir: string): KeyStore {
  const path = join(dir, KEYS_FILE);
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
    return { subject: held, role: session.role === 'admin' ? 'admin' : 'member' };
  };
}

export function installBearerSessions(dir: string, owner: () => string | null, env: NodeJS.ProcessEnv = process.env): void {
  const keys = new SigningKeys(jwksUrl(clientId(env), workosBase(env)), jwksStore(dir));
  setBearerSessions(bearerSessionsFor(owner, keys));
}
