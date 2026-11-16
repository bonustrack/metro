import { filled, JwksKeys, type KeySource } from '@metro-labs/http/workos-token';

export type ProviderId = 'google' | 'microsoft';

export const PROVIDER_IDS: ProviderId[] = ['google', 'microsoft'];

export const isProviderId = (value: unknown): value is ProviderId => value === 'google' || value === 'microsoft';

export const CONSUMER_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad';

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const GOOGLE_SUB_RE = /^[\x21-\x7e]{1,255}$/;
const MICROSOFT_MAIL_DOMAINS = new Set([
  'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
  'outlook.at', 'outlook.be', 'outlook.cl', 'outlook.co.id', 'outlook.co.il', 'outlook.co.th', 'outlook.com.ar', 'outlook.com.au', 'outlook.com.br', 'outlook.com.gr', 'outlook.com.tr', 'outlook.com.vn', 'outlook.cz', 'outlook.de', 'outlook.dk', 'outlook.es', 'outlook.fr', 'outlook.hu', 'outlook.ie', 'outlook.in', 'outlook.it', 'outlook.jp', 'outlook.kr', 'outlook.lv', 'outlook.my', 'outlook.ph', 'outlook.pt', 'outlook.sa', 'outlook.sg', 'outlook.sk',
  'hotmail.be', 'hotmail.ca', 'hotmail.cl', 'hotmail.co.il', 'hotmail.co.jp', 'hotmail.co.kr', 'hotmail.co.th', 'hotmail.co.uk', 'hotmail.co.za', 'hotmail.com.ar', 'hotmail.com.au', 'hotmail.com.br', 'hotmail.com.hk', 'hotmail.com.tr', 'hotmail.com.tw', 'hotmail.com.vn', 'hotmail.cz', 'hotmail.de', 'hotmail.dk', 'hotmail.es', 'hotmail.fi', 'hotmail.fr', 'hotmail.gr', 'hotmail.hu', 'hotmail.it', 'hotmail.lt', 'hotmail.lv', 'hotmail.my', 'hotmail.nl', 'hotmail.no', 'hotmail.ph', 'hotmail.rs', 'hotmail.se', 'hotmail.sg', 'hotmail.sk',
  'live.at', 'live.be', 'live.ca', 'live.cl', 'live.cn', 'live.co.kr', 'live.co.uk', 'live.co.za', 'live.com.ar', 'live.com.au', 'live.com.mx', 'live.com.my', 'live.com.ph', 'live.com.pt', 'live.com.sg', 'live.de', 'live.dk', 'live.fi', 'live.fr', 'live.hk', 'live.ie', 'live.in', 'live.it', 'live.jp', 'live.nl', 'live.no', 'live.ru', 'live.se',
]);
const GOOGLE_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
const KEYS_MAX_AGE_MS = 60 * 60_000;
const NAME_MAX = 80;

export type RefusalReason = 'unverified' | 'other-account' | 'failed';

export class SignInRefused extends Error {
  constructor(
    readonly reason: RefusalReason,
    message: string,
  ) {
    super(message);
  }
}

export interface Endpoints {
  authorize: string;
  token: string;
  jwks: string;
}

export const GOOGLE_ENDPOINTS: Endpoints = {
  authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  jwks: 'https://www.googleapis.com/oauth2/v3/certs',
};

const MICROSOFT_BASE = 'https://login.microsoftonline.com/common';

export const MICROSOFT_ENDPOINTS: Endpoints = {
  authorize: `${MICROSOFT_BASE}/oauth2/v2.0/authorize`,
  token: `${MICROSOFT_BASE}/oauth2/v2.0/token`,
  jwks: `${MICROSOFT_BASE}/discovery/v2.0/keys`,
};

export interface Proof {
  subject: string;
  email: string | null;
  emailProven: boolean;
  name: string | null;
  picture: string | null;
}

export type Claims = Record<string, unknown>;

export interface OAuthProvider {
  id: ProviderId;
  clientId: string;
  clientSecret: string;
  endpoints: Endpoints;
  keys: KeySource;
  scope: string;
  extra: Record<string, string>;
  proof: (claims: Claims) => Proof;
}

export type OAuthProviders = Partial<Record<ProviderId, OAuthProvider>>;

export interface Credentials {
  clientId: string;
  clientSecret: string;
}

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null);
const yes = (value: unknown): boolean => value === true || value === 'true';

function nameOf(claims: Claims): string | null {
  const name = text(claims.name)?.replace(/[\p{Cc}]/gu, '').replace(/\s+/g, ' ').slice(0, NAME_MAX) ?? '';
  return name === '' ? null : name;
}

function httpsPicture(value: unknown): string | null {
  const url = text(value);
  return url !== null && url.startsWith('https://') && url.length <= 2048 ? url : null;
}

const ASCII_EMAIL_RE = /^[!-?A-~]+@[!-?A-~]+\.[!-?A-~]+$/;

const emailOf = (claims: Claims): string | null => {
  const email = text(claims.email)?.toLowerCase() ?? null;
  return email !== null && ASCII_EMAIL_RE.test(email) ? email : null;
};

const domainOf = (email: string): string => email.slice(email.lastIndexOf('@') + 1);

const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

export const googleOwnsEmail = (email: string, hd: unknown): boolean => GMAIL_DOMAINS.has(domainOf(email)) || (typeof hd === 'string' && hd.toLowerCase() === domainOf(email));

export const microsoftOwnDomain = (email: string): boolean => MICROSOFT_MAIL_DOMAINS.has(domainOf(email));

function googleProof(claims: Claims): Proof {
  if (typeof claims.iss !== 'string' || !GOOGLE_ISSUERS.has(claims.iss)) throw new SignInRefused('failed', `Google answered with the issuer ${String(claims.iss)}`);
  const subject = text(claims.sub);
  if (subject === null || !GOOGLE_SUB_RE.test(subject)) throw new SignInRefused('failed', 'Google answered without an account id');
  const email = emailOf(claims);
  if (email === null || !yes(claims.email_verified)) throw new SignInRefused('unverified', 'Google did not confirm the email address');
  return { subject, email, emailProven: googleOwnsEmail(email, claims.hd), name: nameOf(claims), picture: httpsPicture(claims.picture) };
}

function guidOf(value: unknown, what: string): string {
  const id = text(value)?.toLowerCase() ?? '';
  if (!GUID_RE.test(id)) throw new SignInRefused('failed', `Microsoft answered without ${what}`);
  return id;
}

function microsoftProof(claims: Claims): Proof {
  const tenant = guidOf(claims.tid, 'a tenant id');
  if (claims.iss !== `https://login.microsoftonline.com/${tenant}/v2.0`) throw new SignInRefused('failed', `Microsoft answered with the issuer ${String(claims.iss)}`);
  const object = guidOf(claims.oid, 'an object id');
  const email = emailOf(claims);
  const emailProven = email !== null && (yes(claims.xms_edov) || (tenant === CONSUMER_TENANT && microsoftOwnDomain(email)));
  return { subject: `${tenant}:${object}`, email, emailProven, name: nameOf(claims), picture: null };
}

export function googleProvider(credentials: Credentials, endpoints: Endpoints = GOOGLE_ENDPOINTS): OAuthProvider {
  return {
    id: 'google',
    ...credentials,
    endpoints,
    keys: new JwksKeys(endpoints.jwks, undefined, KEYS_MAX_AGE_MS),
    scope: 'openid email profile',
    extra: { prompt: 'select_account' },
    proof: googleProof,
  };
}

export function microsoftProvider(credentials: Credentials, endpoints: Endpoints = MICROSOFT_ENDPOINTS): OAuthProvider {
  return {
    id: 'microsoft',
    ...credentials,
    endpoints,
    keys: new JwksKeys(endpoints.jwks, undefined, KEYS_MAX_AGE_MS),
    scope: 'openid email profile',
    extra: { prompt: 'select_account', response_mode: 'query' },
    proof: microsoftProof,
  };
}

function credentialsOf(env: NodeJS.ProcessEnv, prefix: string): Credentials | null {
  const clientId = filled(env[`${prefix}_OAUTH_CLIENT_ID`]);
  const clientSecret = filled(env[`${prefix}_OAUTH_CLIENT_SECRET`]);
  return clientId === null || clientSecret === null ? null : { clientId, clientSecret };
}

export function readProviders(env: NodeJS.ProcessEnv = process.env): OAuthProviders {
  const google = credentialsOf(env, 'GOOGLE');
  const microsoft = credentialsOf(env, 'MICROSOFT');
  return { ...(google === null ? {} : { google: googleProvider(google) }), ...(microsoft === null ? {} : { microsoft: microsoftProvider(microsoft) }) };
}

export const configuredProviders = (providers: OAuthProviders): ProviderId[] => PROVIDER_IDS.filter((id) => providers[id] !== undefined);
