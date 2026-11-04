import { createHash } from 'node:crypto';
import { ApiError } from '@metro-labs/http/api-error';
import type { ApprovedGrant, GrantRequest } from '@metro-labs/connectors/db/oauth-grants';
import { redirectWith } from '@metro-labs/connectors/db/oauth-grants';
import { clientOf, sameRedirect, type OauthClient } from './clients.js';

export const OAUTH_SCOPE = 'connectors';
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;
const STATE_MAX = 2048;

export interface OauthDeps {
  issuer: string;
  appUrl: string;
  clientKey: Buffer;
  open: (request: GrantRequest, now: number) => Promise<string>;
  redeem: (code: string, now: number) => Promise<ApprovedGrant | null>;
  mint: (grant: ApprovedGrant, now: number) => Promise<string>;
  now: () => number;
}

export type AuthorizeOutcome = { kind: 'refuse'; message: string } | { kind: 'redirect'; location: string };

export interface TokenAnswer {
  status: number;
  body: Record<string, string>;
}

export const resourcesOf = (issuer: string): Set<string> => new Set([issuer, `${issuer}/`, `${issuer}/mcp`]);

function redirectOf(client: OauthClient, given: string | null): string | null {
  if (given === null) return client.redirectUris.length === 1 ? (client.redirectUris[0] ?? null) : null;
  return client.redirectUris.some((uri) => sameRedirect(uri, given)) ? given : null;
}

function requestError(params: URLSearchParams, issuer: string): string | null {
  if (params.get('response_type') !== 'code') return 'unsupported_response_type';
  if (params.get('code_challenge_method') !== 'S256' || !CHALLENGE_RE.test(params.get('code_challenge') ?? '')) return 'invalid_request';
  if ((params.get('state') ?? '').length > STATE_MAX) return 'invalid_request';
  const resource = params.get('resource');
  return resource === null || resourcesOf(issuer).has(resource) ? null : 'invalid_target';
}

const ERROR_TEXT: Record<string, string> = {
  unsupported_response_type: 'Metro only answers response_type=code.',
  invalid_request: 'Metro needs a PKCE S256 code_challenge, and a state of 2048 characters at most.',
  invalid_target: 'This sign-in is for another resource than mcp.metro.box.',
};

export async function authorize(deps: OauthDeps, params: URLSearchParams): Promise<AuthorizeOutcome> {
  const client = clientOf(deps.clientKey, params.get('client_id') ?? '');
  if (client === null) return { kind: 'refuse', message: 'This app is not registered with Metro. Remove the connector in the app and add it again.' };
  const redirectUri = redirectOf(client, params.get('redirect_uri'));
  if (redirectUri === null) return { kind: 'refuse', message: 'This return address was not registered by the app.' };
  const state = params.get('state');
  const error = requestError(params, deps.issuer);
  if (error !== null) return { kind: 'redirect', location: redirectWith(redirectUri, { error, error_description: ERROR_TEXT[error] ?? null, state }) };
  const id = await deps.open({ clientId: params.get('client_id') ?? '', clientName: client.name, redirectUri, codeChallenge: params.get('code_challenge') ?? '', state }, deps.now());
  return { kind: 'redirect', location: `${deps.appUrl}/#/connect/${id}` };
}

const failure = (status: number, error: string, description: string): TokenAnswer => ({ status, body: { error, error_description: description } });

const challengeOf = (verifier: string): string => createHash('sha256').update(verifier, 'ascii').digest('base64url');

function grantMismatch(grant: ApprovedGrant, params: URLSearchParams): string | null {
  if (grant.clientId !== params.get('client_id')) return 'This code was issued to another app.';
  const redirect = params.get('redirect_uri');
  if (redirect !== null && !sameRedirect(grant.redirectUri, redirect)) return 'redirect_uri does not match the one of the sign-in.';
  const verifier = params.get('code_verifier') ?? '';
  return VERIFIER_RE.test(verifier) && challengeOf(verifier) === grant.codeChallenge ? null : 'code_verifier does not match the code_challenge.';
}

function tokenRequestError(deps: OauthDeps, params: URLSearchParams): TokenAnswer | null {
  if (params.get('grant_type') !== 'authorization_code') return failure(400, 'unsupported_grant_type', 'Metro only takes grant_type=authorization_code. Its access keys do not expire, so there is nothing to refresh.');
  if (clientOf(deps.clientKey, params.get('client_id') ?? '') === null) return failure(401, 'invalid_client', 'This app is not registered with Metro.');
  const resource = params.get('resource');
  if (resource !== null && !resourcesOf(deps.issuer).has(resource)) return failure(400, 'invalid_target', 'This token is for another resource than mcp.metro.box.');
  return null;
}

export async function exchange(deps: OauthDeps, params: URLSearchParams): Promise<TokenAnswer> {
  const refused = tokenRequestError(deps, params);
  if (refused !== null) return refused;
  const now = deps.now();
  const grant = await deps.redeem(params.get('code') ?? '', now);
  if (grant === null) return failure(400, 'invalid_grant', 'This code is unknown, used or expired. Sign in again.');
  const mismatch = grantMismatch(grant, params);
  if (mismatch !== null) return failure(400, 'invalid_grant', mismatch);
  try {
    return { status: 200, body: { access_token: await deps.mint(grant, now), token_type: 'Bearer', scope: OAUTH_SCOPE } };
  } catch (err) {
    if (err instanceof ApiError) return failure(400, 'invalid_grant', err.message);
    throw err;
  }
}
