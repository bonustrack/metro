import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, createPrivateKey, createPublicKey, createSign, type KeyObject } from 'node:crypto';
import { errMsg, log } from '@metro-labs/core/log';
import { cors, sendJson } from '@metro-labs/http/api-http';
import { filled, isOrganizationId, METRO_ISSUER, type KeySource } from '@metro-labs/http/user-token';

const JWKS_PATH = '/.well-known/jwks.json';
const ACCESS_TTL_S = 10 * 60;
const MIN_BITS = 2048;
const USER_RE = /^user_[0-9A-Z]{26}$/;

export interface PublicJwk {
  kty: 'RSA';
  n: string;
  e: string;
  kid: string;
  alg: 'RS256';
  use: 'sig';
}

interface SigningKey {
  kid: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
  jwk: PublicJwk;
}

export interface AuthKeys extends KeySource {
  signer: SigningKey | null;
  jwks: { keys: PublicJwk[] };
}

export interface AccessClaims {
  sub: string;
  sid: string;
  org_id?: string;
  role?: 'admin' | 'member';
}

export function thumbprint(publicKey: KeyObject): string {
  const { e, n } = publicKey.export({ format: 'jwk' });
  return createHash('sha256').update(JSON.stringify({ e, kty: 'RSA', n })).digest('base64url');
}

function readKey(pem: string): SigningKey {
  const privateKey = createPrivateKey(pem.replace(/\\n/g, '\n'));
  if (privateKey.asymmetricKeyType !== 'rsa') throw new Error('it is not an RSA key');
  const bits = privateKey.asymmetricKeyDetails?.modulusLength ?? 0;
  if (bits < MIN_BITS) throw new Error(`it has ${String(bits)} bits, ${String(MIN_BITS)} at least are needed`);
  const publicKey = createPublicKey(privateKey);
  const { e, n } = publicKey.export({ format: 'jwk' });
  if (e === undefined || n === undefined) throw new Error('its public half has no modulus or exponent');
  const kid = thumbprint(publicKey);
  return { kid, privateKey, publicKey, jwk: { kty: 'RSA', n, e, kid, alg: 'RS256', use: 'sig' } };
}

function keyFrom(env: NodeJS.ProcessEnv, name: string): SigningKey | null {
  const pem = filled(env[name]);
  if (pem === null) return null;
  try {
    return readKey(pem);
  } catch (err) {
    log.warn({ err: errMsg(err) }, `api: ${name} is not a usable RSA private key in PEM, so it is ignored`);
    return null;
  }
}

export function readSigningKeys(env: NodeJS.ProcessEnv = process.env): AuthKeys {
  const signer = keyFrom(env, 'METRO_AUTH_SIGNING_KEY');
  const next = keyFrom(env, 'METRO_AUTH_NEXT_SIGNING_KEY');
  const published = new Map<string, SigningKey>();
  for (const key of [signer, next]) if (key !== null && !published.has(key.kid)) published.set(key.kid, key);
  return {
    signer,
    jwks: { keys: [...published.values()].map((key) => key.jwk) },
    keyFor: (kid) => Promise.resolve(published.get(kid)?.publicKey ?? null),
  };
}

export function announceSigningKeys(keys: AuthKeys): void {
  const kids = keys.jwks.keys.map((key) => key.kid);
  if (keys.signer === null) log.info({ published: kids }, 'api: Metro sign-in tokens: off, METRO_AUTH_SIGNING_KEY is unset');
  else log.info({ signer: keys.signer.kid, published: kids }, 'api: Metro sign-in tokens: on');
}

const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');

function checkClaims(claims: AccessClaims): void {
  if (!USER_RE.test(claims.sub)) throw new Error('a sign-in token needs a user id shaped user_ and 26 characters');
  if (claims.sid === '') throw new Error('a sign-in token needs a session id');
  if ((claims.org_id === undefined) !== (claims.role === undefined)) throw new Error('a sign-in token carries an organization and a role together, or neither');
  if (claims.org_id !== undefined && !isOrganizationId(claims.org_id)) throw new Error('a sign-in token needs an organization id shaped org_');
}

export function mintAccessToken(keys: AuthKeys, claims: AccessClaims, now = Date.now()): string {
  const signer = keys.signer;
  if (signer === null) throw new Error('METRO_AUTH_SIGNING_KEY is unset, so no sign-in token can be made');
  checkClaims(claims);
  const iat = Math.floor(now / 1000);
  const organization = claims.org_id === undefined ? {} : { org_id: claims.org_id, role: claims.role };
  const head = b64({ alg: 'RS256', typ: 'JWT', kid: signer.kid });
  const body = b64({ iss: METRO_ISSUER, sub: claims.sub, sid: claims.sid, ...organization, iat, exp: iat + ACCESS_TTL_S });
  const signature = createSign('RSA-SHA256').update(`${head}.${body}`).sign(signer.privateKey).toString('base64url');
  return `${head}.${body}.${signature}`;
}

export function handleJwksRequest(req: IncomingMessage, res: ServerResponse, keys: AuthKeys): boolean {
  const path = (req.url ?? '').split('?')[0];
  if (path !== JWKS_PATH) return false;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors(req)).end();
    return true;
  }
  if (req.method !== 'GET') {
    sendJson(req, res, 405, { error: 'method not allowed' });
    return true;
  }
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'max-age=300', ...cors(req) }).end(JSON.stringify(keys.jwks));
  return true;
}
