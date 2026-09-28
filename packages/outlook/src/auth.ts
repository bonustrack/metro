import { postForm, seconds, SignInError, tokensOf, type FetchLike, type OAuthBody, type Tokens } from '@metro-labs/core/stations/oauth';
import { clientId, loginBase, NOT_SET_UP, SCOPES } from './config.js';

export interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  message: string;
  expiresAt: number;
  intervalMs: number;
}

export type Poll =
  | { kind: 'pending' }
  | { kind: 'slow_down' }
  | { kind: 'done'; tokens: Tokens; tenantId: string | null }
  | { kind: 'failed'; message: string };

type Body = OAuthBody;

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const CONSENT_CODES = new Set([65001, 90094, 90095]);
const POLICY_CODES = new Set([530035, 53003]);

const text = (v: unknown): string => (typeof v === 'string' ? v : '');

export function requireClientId(id = clientId()): string {
  if (id === '') throw new SignInError(NOT_SET_UP);
  return id;
}

export const postLogin = (path: string, fields: Record<string, string>, fetchImpl: FetchLike): Promise<{ status: number; body: Body }> =>
  postForm(`${loginBase()}/oauth2/v2.0/${path}`, fields, fetchImpl, 'Microsoft');

function codesOf(body: Body): number[] {
  const listed = Array.isArray(body.error_codes) ? body.error_codes.filter((c): c is number => typeof c === 'number') : [];
  const named = [...text(body.error_description).matchAll(/AADSTS(\d+)/g)].map((m) => Number(m[1]));
  return [...listed, ...named];
}

const needsConsent = (error: string, codes: number[]): boolean =>
  error === 'consent_required' || codes.some((c) => CONSENT_CODES.has(c));

function knownFailure(error: string, codes: number[], id: string): string | null {
  if (needsConsent(error, codes))
    return `An administrator of this Microsoft 365 organization must approve Metro once before it can read this mailbox. They can do it at https://login.microsoftonline.com/organizations/adminconsent?client_id=${id} and then you can start again.`;
  if (codes.some((c) => POLICY_CODES.has(c)))
    return 'Your company blocks this kind of sign-in. Ask your Microsoft 365 administrator, or use the Microsoft sign-in page instead of a code.';
  if (error === 'expired_token' || codes.includes(70020)) return 'The sign-in code expired before it was used. Start again.';
  if (error === 'access_denied' || codes.includes(65004)) return 'The sign-in was declined, so nothing was connected.';
  return null;
}

export function failureOf(body: Body, id = clientId()): string {
  const error = text(body.error);
  const known = knownFailure(error, codesOf(body), id);
  if (known !== null) return known;
  const detail = text(body.error_description).split(/\r?\n/)[0] ?? '';
  return detail === '' ? `Microsoft refused the sign-in (${error === '' ? 'no reason given' : error}).` : `Microsoft refused the sign-in: ${detail}`;
}

function decodeClaims(jwt: string): Body | null {
  const part = jwt.split('.')[1];
  if (part === undefined) return null;
  try {
    const raw: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return typeof raw === 'object' && raw !== null ? (raw as Body) : null;
  } catch {
    return null;
  }
}

export function tenantOf(...jwts: string[]): string | null {
  for (const jwt of jwts) {
    const tid = decodeClaims(jwt)?.tid;
    if (typeof tid === 'string' && tid !== '') return tid;
  }
  return null;
}

export async function requestDeviceCode(fetchImpl: FetchLike = fetch, now = Date.now()): Promise<DeviceCode> {
  const { status, body } = await postLogin('devicecode', { client_id: requireClientId(), scope: SCOPES }, fetchImpl);
  const userCode = text(body.user_code);
  const deviceCode = text(body.device_code);
  if (status !== 200 || userCode === '' || deviceCode === '') throw new SignInError(failureOf(body));
  return {
    deviceCode,
    userCode,
    verificationUri: text(body.verification_uri) || 'https://microsoft.com/devicelogin',
    message: text(body.message),
    expiresAt: now + seconds(body.expires_in, 900) * 1000,
    intervalMs: seconds(body.interval, 5) * 1000,
  };
}

export async function pollDeviceCode(code: DeviceCode, fetchImpl: FetchLike = fetch, now = Date.now()): Promise<Poll> {
  const { status, body } = await postLogin(
    'token',
    { grant_type: DEVICE_GRANT, client_id: requireClientId(), device_code: code.deviceCode },
    fetchImpl,
  );
  if (status === 200) {
    const tokens = tokensOf(body, now, 'Microsoft');
    return { kind: 'done', tokens, tenantId: tenantOf(text(body.id_token), tokens.accessToken) };
  }
  const error = text(body.error);
  if (error === 'authorization_pending') return { kind: 'pending' };
  if (error === 'slow_down') return { kind: 'slow_down' };
  return { kind: 'failed', message: failureOf(body) };
}

export async function refreshTokens(refreshToken: string, fetchImpl: FetchLike = fetch, now = Date.now()): Promise<Tokens> {
  const { status, body } = await postLogin(
    'token',
    { grant_type: 'refresh_token', client_id: requireClientId(), refresh_token: refreshToken, scope: SCOPES },
    fetchImpl,
  );
  if (status !== 200) throw new SignInError(`Microsoft refused to renew this mailbox's sign-in, so connect Outlook again. ${failureOf(body)}`);
  return tokensOf(body, now, 'Microsoft', refreshToken);
}
