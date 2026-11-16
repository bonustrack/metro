import { verify } from 'node:crypto';
import { isRecord } from '@metro-labs/core/is-record';
import { SignInRefused, type Claims, type OAuthProvider } from './providers.js';

const SKEW_S = 60;

function parsed(text: string | undefined): unknown {
  try {
    return JSON.parse(Buffer.from(text ?? '', 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function part(text: string | undefined): Claims {
  const value = parsed(text);
  if (!isRecord(value)) throw new SignInRefused('failed', 'the sign-in token is not readable');
  return value;
}

const audienceHolds = (aud: unknown, clientId: string): boolean => aud === clientId || (Array.isArray(aud) && aud.includes(clientId));

const seconds = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

function checkTimes(claims: Claims, now: number): void {
  const exp = seconds(claims.exp);
  if (exp === null || exp + SKEW_S < now / 1000) throw new SignInRefused('failed', 'the sign-in token has expired');
  const nbf = seconds(claims.nbf);
  if (nbf !== null && nbf - SKEW_S > now / 1000) throw new SignInRefused('failed', 'the sign-in token is not valid yet');
}

interface Pieces {
  signed: string;
  kid: string;
  claims: Claims;
  signature: Buffer;
}

function piecesOf(token: string): Pieces {
  const [head, body, signature, extra] = token.split('.');
  if (head === undefined || body === undefined || signature === undefined || extra !== undefined) throw new SignInRefused('failed', 'the sign-in token is not a JWT');
  const header = part(head);
  if (header.alg !== 'RS256' || typeof header.kid !== 'string' || header.kid === '') throw new SignInRefused('failed', 'the sign-in token is not signed with RS256 and a key id');
  return { signed: `${head}.${body}`, kid: header.kid, claims: part(body), signature: Buffer.from(signature, 'base64url') };
}

export async function verifyIdToken(provider: OAuthProvider, token: string, nonce: string, now: number): Promise<Claims> {
  const { signed, kid, claims, signature } = piecesOf(token);
  const key = await provider.keys.keyFor(kid, now).catch(() => null);
  if (key === null) throw new SignInRefused('failed', 'the sign-in token is signed by an unknown key');
  if (!verify('sha256', Buffer.from(signed), key, signature)) throw new SignInRefused('failed', 'the sign-in token has a bad signature');
  if (!audienceHolds(claims.aud, provider.clientId)) throw new SignInRefused('failed', 'the sign-in token was made for another app');
  if (claims.nonce !== nonce) throw new SignInRefused('failed', 'the sign-in token belongs to another sign-in');
  checkTimes(claims, now);
  return claims;
}
