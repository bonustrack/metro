import type { IncomingMessage, ServerResponse } from 'node:http';
import { verifyTypedData } from 'viem';
import { log } from './log.js';
import { ApiError } from './api-error.js';
import { apiFailure, bodyField, cors, readJsonBody, sendJson } from './api-http.js';
import { ENCRYPTION_KEY_TYPED_DATA, deriveIdentityAddress } from './identity-key.js';
import { authorizeIdentity } from './identity-registry.js';

const PATH = '/auth/identity';
const SIGNATURE_RE = /^0x[0-9a-fA-F]{130}$/;

export interface IdentityRouteDeps {
  owner: () => string | null;
}

async function register(req: IncomingMessage, deps: IdentityRouteDeps): Promise<{ address: string; owner: string }> {
  const signature = bodyField(await readJsonBody(req), 'signature');
  if (typeof signature !== 'string' || !SIGNATURE_RE.test(signature))
    throw new ApiError('signature is required: the EncryptionKey signature of the owner wallet', 400);
  const owner = deps.owner();
  if (owner === null)
    throw new ApiError('this machine has no owner yet: start it with metro serve --owner <address>', 403);
  const ok = await verifyTypedData({
    ...ENCRYPTION_KEY_TYPED_DATA,
    address: owner as `0x${string}`,
    signature: signature as `0x${string}`,
  }).catch(() => false);
  if (!ok) throw new ApiError('this machine belongs to another wallet', 403);
  const address = deriveIdentityAddress(signature as `0x${string}`);
  authorizeIdentity(address, owner);
  log.info({ owner, identity: address }, 'identity: owner signed in');
  return { address, owner };
}

export function handleIdentityRequest(req: IncomingMessage, res: ServerResponse, deps: IdentityRouteDeps): boolean {
  const path = (req.url ?? '').split('?')[0] ?? '';
  if (path !== PATH) return false;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors(req)).end();
    return true;
  }
  if (req.method !== 'POST') {
    sendJson(req, res, 405, { error: 'method not allowed' });
    return true;
  }
  register(req, deps)
    .then((body) => {
      sendJson(req, res, 200, body);
    })
    .catch((err: unknown) => {
      apiFailure(req, res, err, 'identity');
    });
  return true;
}
