import { randomBytes } from 'node:crypto';
import { isRecord } from '@metro-labs/core/is-record';
import { pkcePair } from '@metro-labs/core/stations/oauth';
import { ApiError } from '@metro-labs/http/api-error';
import { asForm, CODEX_ISSUER, CodexTokenError, decodeJwtPayload, emailOf, grantOf, nonEmpty, OPENAI_API, tokenCall, type Grant } from '@metro-labs/connectors/codex-tokens';
import { modelDetailOf, openModelSecret, type CodexSecret } from '@metro-labs/connectors/model-secret';
import { modelKey, type Caller, type CodexPending, type ModelsDeps } from './deps.js';
import { codexRow, OTHER_ACCOUNT, saveCodex } from './codex-save.js';
import { connectionArg } from './input.js';
import type { ConnectionView } from './view.js';

export const CODEX_REDIRECT = 'http://127.0.0.1:1455/auth/callback';
export const NEW_CLIENT = 'dynamic_agent_client';
const APP_NAME = 'Metro';
const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
const SCOPE = `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`;
const AGAIN = 'press Continue with ChatGPT again';

interface Previous {
  clientId: string;
  subject: string | null;
  email: string | null;
}

const bad = (message: string): ApiError => new ApiError(message, 400);

async function previousOf(deps: ModelsDeps, key: Buffer, owner: string, id: string): Promise<Previous | null> {
  const row = await codexRow(deps, owner, id);
  const secret = openModelSecret(key, row);
  if (secret?.kind !== 'codex' || secret.method !== 'chatgpt' || secret.clientId === undefined) return null;
  return { clientId: secret.clientId, subject: secret.subject ?? null, email: modelDetailOf(row.detail).email ?? null };
}

function returning(previous: Previous | null): Record<string, string> {
  if (previous === null) return { client_id: NEW_CLIENT, agent_name_hint: APP_NAME };
  return { client_id: previous.clientId, ...(previous.email === null ? {} : { login_hint: previous.email }) };
}

export async function beginCodexLogin(deps: ModelsDeps, caller: Caller, body: unknown): Promise<{ authorizeUrl: string }> {
  const key = modelKey(deps);
  const connection = connectionArg(body);
  const previous = connection === null ? null : await previousOf(deps, key, caller.owner, connection);
  const hostId = await deps.store.hostId(caller.owner);
  const { verifier, challenge } = pkcePair();
  const nonce = randomBytes(32).toString('base64url');
  const pending: CodexPending = { owner: caller.owner, userId: caller.session.userId, connection, verifier, nonce, clientId: previous?.clientId ?? null, subject: previous?.subject ?? null };
  const { ticket: state } = deps.codexLogins.mint(pending, deps.now());
  const query = new URLSearchParams({
    ...returning(previous),
    ext_agent_host_id: hostId,
    response_type: 'code',
    redirect_uri: CODEX_REDIRECT,
    scope: SCOPE,
    resource: OPENAI_API,
    state,
    nonce,
    code_challenge_method: 'S256',
    code_challenge: challenge,
  });
  return { authorizeUrl: `${CODEX_ISSUER}/api/accounts/authorize?${query.toString()}` };
}

function queryOf(raw: string): URLSearchParams {
  const text = raw.trim();
  try {
    return new URL(text).searchParams;
  } catch {
    return new URLSearchParams(text.replace(/^\?/, ''));
  }
}

const param = (query: URLSearchParams, name: string): string => query.get(name)?.trim() ?? '';

function parseCallback(raw: string): { code: string; state: string; clientId: string | null } {
  const query = queryOf(raw);
  const error = param(query, 'error');
  if (error === 'access_denied') throw bad('you did not allow Metro to use your ChatGPT plan, so nothing was saved');
  if (error !== '') throw bad(`ChatGPT stopped the sign-in (${query.get('error_description') ?? error}); ${AGAIN}`);
  const code = param(query, 'code');
  const state = param(query, 'state');
  if (code === '' || state === '') throw bad('paste the whole address the browser landed on; it carries code= and state=');
  return { code, state, clientId: nonEmpty(param(query, 'client_id')) };
}

function takePending(deps: ModelsDeps, caller: Caller, state: string): CodexPending {
  const started = deps.codexLogins.peek(state, deps.now());
  if (started === undefined) throw bad(`this sign-in link has expired or was started elsewhere; ${AGAIN}`);
  if (started.owner !== caller.owner || started.userId !== caller.session.userId) throw new ApiError('This sign-in was started by someone else, so it cannot finish here.', 403);
  deps.codexLogins.take(state, deps.now());
  return started;
}

function clientOf(started: CodexPending, returned: string | null): string {
  const clientId = started.clientId ?? returned;
  if (clientId === null || clientId === NEW_CLIENT) throw bad(`ChatGPT did not finish registering Metro; ${AGAIN}`);
  if (returned !== null && returned !== clientId) throw bad(`ChatGPT answered for another Metro registration; ${AGAIN}`);
  return clientId;
}

function identityOf(idToken: unknown, clientId: string, nonce: string): { subject: string; email: string | null } {
  const claims = decodeJwtPayload(idToken);
  const audience: unknown[] = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  const subject = nonEmpty(claims.sub);
  if (subject === null || claims.iss !== CODEX_ISSUER || !audience.includes(clientId) || claims.nonce !== nonce)
    throw bad(`OpenAI sent back an identity that does not match this sign-in; ${AGAIN}`);
  return { subject, email: emailOf(claims) };
}

export const refused = (err: unknown): never => {
  if (err instanceof CodexTokenError) throw bad(err.message);
  throw err;
};

export function grantFrom(body: Record<string, unknown>, now: number): Grant {
  try {
    return grantOf(body, '', now);
  } catch (err) {
    return refused(err);
  }
}

export async function finishCodexLogin(deps: ModelsDeps, caller: Caller, body: unknown): Promise<{ connection: ConnectionView }> {
  modelKey(deps);
  const { code, state, clientId: returned } = parseCallback(isRecord(body) && typeof body.url === 'string' ? body.url : '');
  const started = takePending(deps, caller, state);
  const clientId = clientOf(started, returned);
  const fields = { grant_type: 'authorization_code', client_id: clientId, code, code_verifier: started.verifier, redirect_uri: CODEX_REDIRECT, resource: OPENAI_API };
  const granted = await tokenCall(`${CODEX_ISSUER}/api/accounts/oauth/token`, asForm(fields), deps.fetch).catch(refused);
  const who = identityOf(granted.id_token, clientId, started.nonce);
  if (started.subject !== null && who.subject !== started.subject) throw new ApiError(OTHER_ACCOUNT, 409);
  if (!(nonEmpty(granted.scope) ?? '').split(/\s+/).includes(PLAN_SCOPE)) throw bad('ChatGPT did not allow Metro to use your plan: sign in again and allow it (it needs ChatGPT Plus or Pro)');
  const secret: CodexSecret = { kind: 'codex', method: 'chatgpt', ...grantFrom(granted, deps.now()), clientId, subject: who.subject };
  return saveCodex(deps, caller, started.connection, secret, { method: 'chatgpt', ...(who.email === null ? {} : { email: who.email }) });
}
