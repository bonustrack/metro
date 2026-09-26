import type { IncomingMessage } from 'node:http';
import { log, errMsg } from '@metro-labs/core/log';
import { isRecord } from '@metro-labs/core/is-record';
import { ApiError } from '@metro-labs/http/api-error';
import { readJsonBody } from '@metro-labs/http/api-http';
import type { Intent } from './operator.js';
import { exchangeMagicCode, sendMagicCode, WorkosError, type Tokens, type WorkosConfig } from './workos.js';

const INVITATION_RE = /^[A-Za-z0-9_-]{8,200}$/;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;
const EMAIL_MAX = 254;
const CODE_RE = /^\d{6}$/;
const WINDOW_MS = 10 * 60_000;
const SENDS_PER_WINDOW = 5;
const CHECKS_PER_WINDOW = 10;
const TRACKED_MAX = 5000;

interface EmailDeps {
  config: () => WorkosConfig | null;
  now?: () => number;
}

type Land<D> = (deps: D, tokens: Tokens, intent: Intent, now: number) => Promise<string>;

export function invitationFrom(value: string): { invitation?: string } {
  if (value === '') return {};
  if (!INVITATION_RE.test(value)) throw new ApiError('invitation_token is not an invitation', 400);
  return { invitation: value };
}

const sends = new Map<string, number[]>();
const checks = new Map<string, number[]>();

function spend(map: Map<string, number[]>, key: string, limit: number, now: number): boolean {
  const recent = (map.get(key) ?? []).filter((at) => now - at < WINDOW_MS);
  if (recent.length >= limit) return false;
  map.delete(key);
  map.set(key, [...recent, now]);
  while (map.size > TRACKED_MAX) {
    const first = map.keys().next().value;
    if (first === undefined) break;
    map.delete(first);
  }
  return true;
}

function configOf(deps: EmailDeps): WorkosConfig {
  const cfg = deps.config();
  if (cfg === null) throw new ApiError('sign-in is not configured on this server', 503);
  return cfg;
}

interface EmailBody {
  email: string;
  code: string;
  intent: Intent;
  invitation?: string;
}

async function emailBody(req: IncomingMessage): Promise<EmailBody> {
  const body = await readJsonBody(req);
  const field = (name: string): string => (isRecord(body) && typeof body[name] === 'string' ? body[name].trim() : '');
  const email = field('email').toLowerCase();
  if (email.length > EMAIL_MAX || !EMAIL_RE.test(email)) throw new ApiError('Enter a valid email address.', 400);
  return { email, code: field('code'), intent: field('intent') === 'waitlist' ? 'waitlist' : 'login', ...invitationFrom(field('invitation')) };
}

export async function startEmailCode(req: IncomingMessage, deps: EmailDeps): Promise<unknown> {
  const cfg = configOf(deps);
  const body = await emailBody(req);
  if (!spend(sends, body.email, SENDS_PER_WINDOW, (deps.now ?? Date.now)())) throw new ApiError('Too many codes asked for this address. Wait ten minutes, then try again.', 429);
  try {
    await sendMagicCode(cfg, body.email, body.invitation);
  } catch (err) {
    log.warn({ err: errMsg(err) }, 'auth: WorkOS did not send the email code');
    if (err instanceof WorkosError && err.code === 'authentication_method_not_allowed') throw new ApiError('Sign-in by email code is not turned on yet. Use Google, Microsoft or GitHub for now.', 503);
    throw new ApiError('The code could not be sent. Try again in a minute.', 503);
  }
  log.info({ invited: body.invitation !== undefined }, 'auth: email code sent');
  return { ok: true };
}

export async function verifyEmailCode<D extends EmailDeps>(req: IncomingMessage, deps: D, land: Land<D>): Promise<unknown> {
  const cfg = configOf(deps);
  const body = await emailBody(req);
  if (!CODE_RE.test(body.code)) throw new ApiError('The code is the six digits from the email.', 400);
  const now = (deps.now ?? Date.now)();
  if (!spend(checks, body.email, CHECKS_PER_WINDOW, now)) throw new ApiError('Too many tries for this address. Wait ten minutes, then ask for a new code.', 429);
  let tokens: Tokens;
  try {
    tokens = await exchangeMagicCode(cfg, body.email, body.code, body.invitation);
  } catch (err) {
    log.info({ err: errMsg(err) }, 'auth: the email code was refused');
    if (err instanceof WorkosError && err.status === 401) throw new ApiError('That code is not right or has expired. Ask for a new one.', 400);
    throw err;
  }
  return { hash: await land(deps, tokens, body.intent, now) };
}
