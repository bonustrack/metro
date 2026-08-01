import {
  createPublicKey,
  verify as cryptoVerify,
  type JsonWebKey as CryptoJsonWebKey,
} from 'node:crypto';

export class GoogleAuthError extends Error {}

interface GoogleClaims {
  email: string;
  emailVerified: boolean;
  aud: string;
  iss: string;
  exp: number;
}

interface Jwk {
  kid: string;
  kty: string;
  alg?: string;
  n: string;
  e: string;
}

interface VerifyOptions {
  clientId: string;
  now?: number;
  fetchCerts?: () => Promise<Jwk[]>;
  clockToleranceSec?: number;
  expectedNonce?: string;
}

const DEFAULT_CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const certsUrl = (): string => {
  const v = process.env.GOOGLE_OAUTH_JWKS_URL?.trim();
  return v !== undefined && v !== '' ? v : DEFAULT_CERTS_URL;
};
const GOOGLE_ISSUERS = new Set([
  'https://accounts.google.com',
  'accounts.google.com',
]);

const decodeSegment = (seg: string): Buffer =>
  Buffer.from(seg.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

const decodeJson = (seg: string): unknown => {
  try {
    return JSON.parse(decodeSegment(seg).toString('utf8'));
  } catch {
    throw new GoogleAuthError('malformed token segment');
  }
};

let certCache: { keys: Jwk[]; expiresAt: number } | null = null;

async function fetchGoogleCerts(): Promise<Jwk[]> {
  const res = await fetch(certsUrl());
  if (!res.ok)
    throw new GoogleAuthError(`google certs fetch failed: ${res.status}`);
  const body = (await res.json()) as { keys?: Jwk[] };
  const maxAge = /max-age=(\d+)/.exec(res.headers.get('cache-control') ?? '');
  const ttlMs = maxAge ? Number(maxAge[1]) * 1000 : 3600_000;
  const keys = body.keys ?? [];
  certCache = { keys, expiresAt: Date.now() + ttlMs };
  return keys;
}

async function loadCerts(
  fetcher: () => Promise<Jwk[]>,
): Promise<Jwk[]> {
  if (certCache && certCache.expiresAt > Date.now()) return certCache.keys;
  return fetcher();
}

function jwkPublicKey(jwk: Jwk): ReturnType<typeof createPublicKey> {
  return createPublicKey({
    key: jwk as unknown as CryptoJsonWebKey,
    format: 'jwk',
  });
}

function verifySignature(token: string, jwk: Jwk): boolean {
  const parts = token.split('.');
  const signingInput = `${parts[0]}.${parts[1]}`;
  const signature = decodeSegment(parts[2] ?? '');
  return cryptoVerify(
    'RSA-SHA256',
    Buffer.from(signingInput),
    jwkPublicKey(jwk),
    signature,
  );
}

interface Header {
  alg?: string;
  kid?: string;
}

interface Payload {
  iss?: string;
  aud?: string;
  exp?: number;
  email?: string;
  email_verified?: boolean | string;
  nonce?: string;
}

function assertHeader(header: Header): asserts header is Header & { kid: string } {
  if (header.alg !== 'RS256')
    throw new GoogleAuthError(`unsupported alg ${String(header.alg)}`);
  if (!header.kid) throw new GoogleAuthError('missing kid');
}

function assertNotExpired(payload: Payload, opts: VerifyOptions): number {
  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  const skew = opts.clockToleranceSec ?? 60;
  if (typeof payload.exp !== 'number' || payload.exp + skew < now)
    throw new GoogleAuthError('token expired');
  return payload.exp;
}

function verifiedEmail(payload: Payload): string {
  const verified =
    payload.email_verified === true || payload.email_verified === 'true';
  if (!payload.email || !verified)
    throw new GoogleAuthError('email not verified');
  return payload.email.toLowerCase();
}

function validateClaims(payload: Payload, opts: VerifyOptions): GoogleClaims {
  if (!payload.iss || !GOOGLE_ISSUERS.has(payload.iss))
    throw new GoogleAuthError(`unexpected issuer ${String(payload.iss)}`);
  if (payload.aud !== opts.clientId)
    throw new GoogleAuthError('audience mismatch');
  if (opts.expectedNonce !== undefined && payload.nonce !== opts.expectedNonce)
    throw new GoogleAuthError('nonce mismatch');
  const exp = assertNotExpired(payload, opts);
  return {
    email: verifiedEmail(payload),
    emailVerified: true,
    aud: payload.aud,
    iss: payload.iss,
    exp,
  };
}

export async function verifyGoogleIdToken(
  token: string,
  opts: VerifyOptions,
): Promise<GoogleClaims> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new GoogleAuthError('not a JWT');
  const header = decodeJson(parts[0] ?? '') as Header;
  const payload = decodeJson(parts[1] ?? '') as Payload;
  assertHeader(header);

  const keys = await loadCerts(opts.fetchCerts ?? fetchGoogleCerts);
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new GoogleAuthError('signing key not found');
  if (!verifySignature(token, jwk))
    throw new GoogleAuthError('invalid signature');

  return validateClaims(payload, opts);
}

export type EmailAgentMap = Record<string, string[]>;

export function parseEmailAgentMap(raw: string | undefined): EmailAgentMap {
  if (!raw || raw.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new GoogleAuthError('GOOGLE_EMAIL_AGENTS is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new GoogleAuthError('GOOGLE_EMAIL_AGENTS must be an object');
  const out: EmailAgentMap = {};
  for (const [email, agents] of Object.entries(parsed)) {
    if (!Array.isArray(agents) || agents.some((a) => typeof a !== 'string'))
      throw new GoogleAuthError(
        `GOOGLE_EMAIL_AGENTS[${email}] must be a string array`,
      );
    out[email.toLowerCase()] = agents as string[];
  }
  return out;
}

export function agentsForEmail(
  map: EmailAgentMap,
  email: string,
): string[] | undefined {
  const agents = map[email.toLowerCase()];
  return agents && agents.length > 0 ? agents : undefined;
}

export function parseSigninDomains(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean);
}

export function signinAllowed(
  email: string,
  domains: string[],
  granted: boolean,
): boolean {
  if (granted || domains.length === 0) return true;
  const at = email.lastIndexOf('@');
  return at >= 0 && domains.includes(email.slice(at + 1).toLowerCase());
}
