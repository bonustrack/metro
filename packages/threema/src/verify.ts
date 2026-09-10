import { createPrivateKey, createPublicKey } from 'node:crypto';
import {
  GATEWAY_API,
  isGatewayId,
  normalizeThreemaId,
  parsePrivateKey,
} from './ids.js';

export { parsePrivateKey } from './ids.js';

export class ThreemaGatewayError extends Error {}

export interface ThreemaCredentials {
  gatewayId: string;
  secret: string;
  privateKey: string;
}

export interface ThreemaGatewayIdentity {
  gatewayId: string;
  publicKey: string;
  credits: number;
}

const PKCS8_X25519_PREFIX = Buffer.from(
  '302e020100300506032b656e04220420',
  'hex',
);
const TIMEOUT_MS = 10_000;
const PUBLIC_KEY_RE = /^[0-9a-f]{64}$/;

export function publicKeyOf(privateKeyHex: string): string {
  const der = Buffer.concat([
    PKCS8_X25519_PREFIX,
    Buffer.from(privateKeyHex, 'hex'),
  ]);
  const key = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  const jwk = createPublicKey(key).export({ format: 'jwk' });
  return Buffer.from(String(jwk.x), 'base64url').toString('hex');
}

async function gatewayGet(
  path: string,
  gatewayId: string,
  secret: string,
): Promise<Response> {
  const query = new URLSearchParams({ from: gatewayId, secret });
  try {
    return await fetch(`${GATEWAY_API}${path}?${query.toString()}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new ThreemaGatewayError(
      'could not reach the Threema Gateway to check those credentials',
    );
  }
}

function refused(res: Response, what: string): ThreemaGatewayError {
  if (res.status === 401)
    return new ThreemaGatewayError(
      'Threema rejected that Gateway ID or API secret',
    );
  if (res.status === 404)
    return new ThreemaGatewayError(`Threema does not know ${what}`);
  return new ThreemaGatewayError(
    `the Threema Gateway answered ${res.status} while checking ${what}`,
  );
}

async function fetchCredits(gatewayId: string, secret: string): Promise<number> {
  const res = await gatewayGet('/credits', gatewayId, secret);
  if (!res.ok) throw refused(res, 'the credit balance');
  const credits = Number((await res.text()).trim());
  if (!Number.isInteger(credits))
    throw new ThreemaGatewayError(
      'the Threema Gateway gave an unexpected answer for the credit balance',
    );
  return credits;
}

async function fetchPublicKey(gatewayId: string, secret: string): Promise<string> {
  const res = await gatewayGet(
    `/pubkeys/${encodeURIComponent(gatewayId)}`,
    gatewayId,
    secret,
  );
  if (!res.ok) throw refused(res, `the public key of ${gatewayId}`);
  const hex = (await res.text()).trim().toLowerCase();
  if (!PUBLIC_KEY_RE.test(hex))
    throw new ThreemaGatewayError(
      'the Threema Gateway gave an unexpected answer for the public key',
    );
  return hex;
}

export async function verifyThreemaGateway(
  input: ThreemaCredentials,
): Promise<ThreemaGatewayIdentity> {
  const gatewayId = normalizeThreemaId(input.gatewayId);
  if (!isGatewayId(gatewayId))
    throw new ThreemaGatewayError(
      'a Threema Gateway ID is a * followed by 7 letters or digits, as in *ABCDEFG',
    );
  const privateKey = parsePrivateKey(input.privateKey);
  if (privateKey === null)
    throw new ThreemaGatewayError(
      'the private key is the 64 hex characters from the key file Threema gave you, with or without its private: prefix',
    );
  const credits = await fetchCredits(gatewayId, input.secret);
  const registered = await fetchPublicKey(gatewayId, input.secret);
  if (registered !== publicKeyOf(privateKey))
    throw new ThreemaGatewayError(
      `that private key does not belong to ${gatewayId}: the Gateway holds a different public key for it`,
    );
  return { gatewayId, publicKey: registered, credits };
}
