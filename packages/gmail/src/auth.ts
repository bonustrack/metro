import { postForm, SignInError, tokensOf, type FetchLike, type OAuthBody, type Tokens } from '@metro-labs/core/stations/oauth';
import { apiBase, authorizeBase, redirectUri, scopesFor, tokenUrl } from './config.js';

export function checkScopes(scope: unknown, sendEnabled: boolean): void {
  const granted = typeof scope === 'string' ? scope.split(/\s+/).filter(Boolean) : [];
  const wanted = scopesFor(sendEnabled).split(' ');
  if (wanted.some((s) => !granted.includes(s)) || granted.some((s) => !wanted.includes(s)))
    throw new SignInError('Google did not grant exactly the requested Gmail access. Review this app in your Google Account, then connect again.');
}

export interface GmailClient {
  clientId: string;
  clientSecret: string;
}

const CLIENT_ID_RE = /^[\w.-]+\.apps\.googleusercontent\.com$/;

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

export function clientOf(rawId: unknown, rawSecret: unknown): GmailClient {
  const clientId = text(rawId);
  const clientSecret = text(rawSecret);
  if (!CLIENT_ID_RE.test(clientId))
    throw new SignInError('Paste the client ID of your Google OAuth client. It ends with .apps.googleusercontent.com.');
  if (clientSecret === '' || /\s/.test(clientSecret)) throw new SignInError('Paste the client secret of your Google OAuth client.');
  return { clientId, clientSecret };
}

export function failureOf(body: OAuthBody): string {
  const error = text(body.error);
  if (error === 'access_denied') return 'The sign-in was declined, so nothing was connected.';
  if (error === 'invalid_client' || error === 'unauthorized_client')
    return 'Google does not accept this client ID and secret. Check both on the Clients page of your Google Cloud project.';
  if (error === 'redirect_uri_mismatch') return `Your Google OAuth client must list ${redirectUri()} as an authorized redirect URI.`;
  if (error === 'admin_policy_enforced') return 'Your Google Workspace administrator blocks this app. Trust it in the Admin console under API controls, then start again.';
  const detail = text(body.error_description);
  return detail === '' ? `Google refused the sign-in (${error === '' ? 'no reason given' : error}).` : `Google refused the sign-in: ${detail}`;
}

export function authorizeUrl(client: GmailClient, challenge: string, state: string, loginHint: string | null, sendEnabled = false): string {
  const query = new URLSearchParams({
    ...(loginHint === null ? {} : { login_hint: loginHint }),
    client_id: client.clientId,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: scopesFor(sendEnabled),
    ...(sendEnabled ? { include_granted_scopes: 'true' } : {}),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    access_type: 'offline',
    prompt: 'select_account consent',
  });
  return `${authorizeBase()}?${query.toString()}`;
}

const post = (fields: Record<string, string>, fetchImpl: FetchLike): Promise<{ status: number; body: OAuthBody }> =>
  postForm(tokenUrl(), fields, fetchImpl, 'Google');

export async function redeemCode(client: GmailClient, code: string, verifier: string, fetchImpl: FetchLike, now = Date.now(), sendEnabled = false): Promise<Tokens> {
  const { status, body } = await post(
    {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri(),
      client_id: client.clientId,
      client_secret: client.clientSecret,
    },
    fetchImpl,
  );
  if (status !== 200) throw new SignInError(failureOf(body));
  checkScopes(body.scope, sendEnabled);
  return tokensOf(body, now, 'Google');
}

export async function refreshTokens(client: GmailClient, refreshToken: string, fetchImpl: FetchLike, now = Date.now(), sendEnabled?: boolean): Promise<Tokens> {
  const { status, body } = await post(
    { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: client.clientId, client_secret: client.clientSecret },
    fetchImpl,
  );
  if (status !== 200) throw new SignInError(`Google refused to renew this mailbox's sign-in, so connect Gmail again. ${failureOf(body)}`);
  if (sendEnabled !== undefined) checkScopes(body.scope, sendEnabled);
  return tokensOf(body, now, 'Google', refreshToken);
}

export async function googleMessage(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: { message?: unknown; status?: unknown } };
  const status = typeof body.error?.status === 'string' ? body.error.status : '';
  const message = typeof body.error?.message === 'string' ? body.error.message : '';
  return [status, message].filter((s) => s !== '').join(': ') || `HTTP ${String(res.status)}`;
}

const wrongMailbox = (actual: string, wanted: string): string =>
  `You signed in as ${actual}, not ${wanted}. Nothing was connected. Start again and pick ${wanted} on Google's page.`;

export async function verifyMailbox(accessToken: string, fetchImpl: FetchLike, wanted: string | null): Promise<string> {
  let res: Response;
  try {
    res = await fetchImpl(`${apiBase()}/gmail/v1/users/me/profile`, {
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
    });
  } catch (err) {
    throw new SignInError(`Metro could not reach Gmail: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) {
    const hint = res.status === 403 ? ' Check that the Gmail API is enabled in your Google Cloud project.' : '';
    throw new SignInError(`Gmail refused the new sign-in (${await googleMessage(res)}), so nothing was connected.${hint}`);
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const email = text(body.emailAddress).toLowerCase();
  if (email === '') throw new SignInError('Gmail did not say which mailbox this is, so nothing was connected.');
  if (wanted !== null && wanted !== email) throw new SignInError(wrongMailbox(email, wanted));
  return email;
}
