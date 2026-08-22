import type { IncomingMessage, ServerResponse } from 'node:http';
import { errMsg, log } from './log.js';
import { verifyGoogleIdToken } from './google-auth.js';
import { newNonce, signSession, signState, verifyState } from './session.js';
import { ensureUserWithProject } from '../db/projects.js';

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  authUrl: string;
  tokenUrl: string;
  sessionSecret: string;
  sessionTtlSec: number;
}

const DEFAULT_REDIRECT_URI = 'https://mcp.metro.box/auth/google/callback';
const DEFAULT_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const DEFAULT_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const PREVIEW = /^([a-z0-9-]+--)?metro-ui\.netlify\.app$/;

const DEFAULT_SESSION_TTL_SEC = 30 * 24 * 3600;

const envOr = (name: string, def: string): string => {
  const v = process.env[name]?.trim();
  return v !== undefined && v !== '' ? v : def;
};

export function sessionTtlFromEnv(): number {
  const ttl = Number(process.env.METRO_SESSION_TTL_SEC);
  return Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_SESSION_TTL_SEC;
}

function oauthConfigFromEnv(): OAuthConfig | null {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim() ?? '';
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim() ?? '';
  const sessionSecret = process.env.METRO_SESSION_SECRET?.trim() ?? '';
  if (clientId === '' || clientSecret === '' || sessionSecret === '') return null;
  return {
    clientId,
    clientSecret,
    sessionSecret,
    redirectUri: envOr('GOOGLE_OAUTH_REDIRECT_URI', DEFAULT_REDIRECT_URI),
    authUrl: envOr('GOOGLE_OAUTH_AUTH_URL', DEFAULT_AUTH_URL),
    tokenUrl: envOr('GOOGLE_OAUTH_TOKEN_URL', DEFAULT_TOKEN_URL),
    sessionTtlSec: sessionTtlFromEnv(),
  };
}

export function validateReturnTo(returnTo: string): boolean {
  let url: URL;
  try {
    url = new URL(returnTo);
  } catch {
    return false;
  }
  const host = url.hostname;
  if (url.protocol === 'http:' && (host === 'localhost' || host === '127.0.0.1'))
    return true;
  if (url.protocol !== 'https:') return false;
  if (host === 'metro.box' || host === 'localhost') return true;
  return PREVIEW.test(host);
}

export function buildStartRedirect(
  cfg: OAuthConfig,
  returnTo: string,
  now?: number,
): string {
  if (!validateReturnTo(returnTo)) throw new Error('invalid return_to');
  const nonce = newNonce();
  const state = signState(
    { return_to: returnTo, nonce },
    cfg.sessionSecret,
    { now },
  );
  const u = new URL(cfg.authUrl);
  u.searchParams.set('client_id', cfg.clientId);
  u.searchParams.set('redirect_uri', cfg.redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', 'openid email');
  u.searchParams.set('state', state);
  u.searchParams.set('nonce', nonce);
  u.searchParams.set('prompt', 'select_account');
  return u.toString();
}

function withFragment(returnTo: string, frag: string): string {
  return `${returnTo.split('#')[0]}#${frag}`;
}

export interface CallbackDeps {
  exchangeCode: (code: string) => Promise<{ id_token?: string }>;
  verifyIdToken: (idToken: string, nonce: string) => Promise<{ email: string }>;
  ensureUser: (email: string) => Promise<string>;
}

export async function completeCallback(
  cfg: OAuthConfig,
  params: { code?: string; state?: string },
  deps: CallbackDeps,
  now?: number,
): Promise<string> {
  if (!params.state) throw new Error('missing state');
  const { return_to, nonce } = verifyState(params.state, cfg.sessionSecret, now);
  if (!validateReturnTo(return_to)) throw new Error('invalid return_to');
  if (!params.code) return withFragment(return_to, 'error=exchange');

  const tokens = await deps.exchangeCode(params.code);
  if (!tokens.id_token) return withFragment(return_to, 'error=exchange');

  let email: string;
  try {
    ({ email } = await deps.verifyIdToken(tokens.id_token, nonce));
  } catch {
    return withFragment(return_to, 'error=verify');
  }

  const userId = await deps.ensureUser(email);
  const agentIds: string[] = [];
  log.info({ userId }, 'google auth: session issued');

  const session = signSession({ email, agentIds }, cfg.sessionSecret, {
    ttlSec: cfg.sessionTtlSec,
    now,
  });
  return withFragment(return_to, `session=${encodeURIComponent(session)}`);
}

async function exchangeCode(
  cfg: OAuthConfig,
  code: string,
): Promise<{ id_token?: string }> {
  const res = await fetch(cfg.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: cfg.redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status}`);
  return (await res.json()) as { id_token?: string };
}

function defaultDeps(cfg: OAuthConfig): CallbackDeps {
  return {
    exchangeCode: (code) => exchangeCode(cfg, code),
    verifyIdToken: (idToken, nonce) =>
      verifyGoogleIdToken(idToken, {
        clientId: cfg.clientId,
        expectedNonce: nonce,
      }).then((c) => ({ email: c.email })),
    ensureUser: ensureUserWithProject,
    
  };
}

function serveStart(cfg: OAuthConfig, url: URL, res: ServerResponse): void {
  const redirect = buildStartRedirect(cfg, url.searchParams.get('return_to') ?? '');
  res.writeHead(302, { location: redirect }).end();
}

async function serveCallback(
  cfg: OAuthConfig,
  url: URL,
  res: ServerResponse,
): Promise<void> {
  const redirect = await completeCallback(
    cfg,
    {
      code: url.searchParams.get('code') ?? undefined,
      state: url.searchParams.get('state') ?? undefined,
    },
    defaultDeps(cfg),
  );
  res.writeHead(302, { location: redirect }).end();
}

export async function handleGoogleAuthRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  if (path !== '/auth/google/start' && path !== '/auth/google/callback')
    return false;
  if (req.method !== 'GET') {
    res.writeHead(405).end();
    return true;
  }
  const cfg = oauthConfigFromEnv();
  if (!cfg) {
    res.writeHead(503).end('google login not configured');
    return true;
  }
  try {
    if (path === '/auth/google/start') serveStart(cfg, url, res);
    else await serveCallback(cfg, url, res);
  } catch (e) {
    log.warn({ err: errMsg(e) }, 'google auth request failed');
    res.writeHead(400).end('bad request');
  }
  return true;
}
