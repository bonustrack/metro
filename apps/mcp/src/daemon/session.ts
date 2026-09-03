import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { ID_RE } from '../db/ids.js';

export class SessionError extends Error {}

const b64url = (buf: Buffer): string =>
  buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

const b64urlJson = (v: unknown): string =>
  b64url(Buffer.from(JSON.stringify(v)));

const decodeJson = (seg: string): unknown =>
  JSON.parse(
    Buffer.from(seg.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString(
      'utf8',
    ),
  );

const HEADER = b64urlJson({ alg: 'HS256', typ: 'JWT' });

function sign(payload: Record<string, unknown>, secret: string): string {
  if (secret === '') throw new SessionError('missing signing secret');
  const body = b64urlJson(payload);
  const data = `${HEADER}.${body}`;
  const sig = b64url(createHmac('sha256', secret).update(data).digest());
  return `${data}.${sig}`;
}

function verify(token: string, secret: string): Record<string, unknown> {
  if (secret === '') throw new SessionError('missing signing secret');
  const parts = token.split('.');
  if (parts.length !== 3) throw new SessionError('malformed token');
  const data = `${parts[0]}.${parts[1]}`;
  const expected = b64url(createHmac('sha256', secret).update(data).digest());
  const a = Buffer.from(parts[2] ?? '');
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b))
    throw new SessionError('bad signature');
  let payload: unknown;
  try {
    payload = decodeJson(parts[1] ?? '');
  } catch {
    throw new SessionError('malformed payload');
  }
  if (typeof payload !== 'object' || payload === null)
    throw new SessionError('malformed payload');
  return payload as Record<string, unknown>;
}

const nowSec = (now?: number): number => Math.floor((now ?? Date.now()) / 1000);

export function newNonce(): string {
  return b64url(randomBytes(16));
}

interface StateClaims {
  return_to: string;
  nonce: string;
}

export function signState(
  claims: StateClaims,
  secret: string,
  opts: { ttlSec?: number; now?: number } = {},
): string {
  const iat = nowSec(opts.now);
  return sign(
    {
      typ: 'state',
      return_to: claims.return_to,
      nonce: claims.nonce,
      iat,
      exp: iat + (opts.ttlSec ?? 600),
    },
    secret,
  );
}

export function verifyState(
  token: string,
  secret: string,
  now?: number,
): StateClaims {
  const p = verify(token, secret);
  if (p.typ !== 'state') throw new SessionError('wrong token type');
  if (typeof p.exp !== 'number' || p.exp < nowSec(now))
    throw new SessionError('state expired');
  if (typeof p.return_to !== 'string' || typeof p.nonce !== 'string')
    throw new SessionError('malformed state');
  return { return_to: p.return_to, nonce: p.nonce };
}

interface SessionClaims {
  subject: string;
  agentIds: string[];
}

export interface AgentClaims {
  subject: string;
  agentId: string;
}

export interface RunClaims {
  subject: string;
  agentId: string;
  runtimeId: string;
}

export function signSession(
  claims: SessionClaims,
  secret: string,
  opts: { ttlSec?: number; now?: number } = {},
): string {
  const iat = nowSec(opts.now);
  return sign(
    {
      typ: 'session',
      sub: claims.subject,
      agent_ids: claims.agentIds,
      iat,
      exp: iat + (opts.ttlSec ?? 30 * 24 * 3600),
    },
    secret,
  );
}

export function verifySession(
  token: string,
  secret: string,
  now?: number,
): SessionClaims {
  const p = verify(token, secret);
  if (p.typ !== 'session') throw new SessionError('wrong token type');
  if (typeof p.exp !== 'number' || p.exp < nowSec(now))
    throw new SessionError('session expired');
  const ids = p.agent_ids;
  if (
    typeof p.sub !== 'string' ||
    !Array.isArray(ids) ||
    ids.some((a) => typeof a !== 'string' || !ID_RE.test(a))
  )
    throw new SessionError('malformed session');
  return { subject: p.sub, agentIds: ids as string[] };
}

export function signAgentToken(
  claims: AgentClaims,
  secret: string,
  opts: { ttlSec?: number; now?: number } = {},
): string {
  const iat = nowSec(opts.now);
  return sign(
    {
      typ: 'agent',
      sub: claims.subject,
      agent: claims.agentId,
      iat,
      exp: iat + (opts.ttlSec ?? 30 * 24 * 3600),
    },
    secret,
  );
}

export function verifyAgentToken(
  token: string,
  secret: string,
  now?: number,
): AgentClaims {
  const p = verify(token, secret);
  if (p.typ !== 'agent') throw new SessionError('wrong token type');
  if (typeof p.exp !== 'number' || p.exp < nowSec(now))
    throw new SessionError('agent token expired');
  if (typeof p.sub !== 'string' || typeof p.agent !== 'string')
    throw new SessionError('malformed agent token');
  return { subject: p.sub, agentId: p.agent };
}

export function signRunToken(
  claims: RunClaims,
  secret: string,
  opts: { ttlSec?: number; now?: number } = {},
): string {
  const iat = nowSec(opts.now);
  return sign(
    {
      typ: 'run',
      sub: claims.subject,
      agent: claims.agentId,
      rt: claims.runtimeId,
      iat,
      exp: iat + (opts.ttlSec ?? 365 * 24 * 3600),
    },
    secret,
  );
}

export function verifyRunToken(
  token: string,
  secret: string,
  now?: number,
): RunClaims {
  const p = verify(token, secret);
  if (p.typ !== 'run') throw new SessionError('wrong token type');
  if (typeof p.exp !== 'number' || p.exp < nowSec(now))
    throw new SessionError('run token expired');
  if (
    typeof p.sub !== 'string' ||
    typeof p.agent !== 'string' ||
    typeof p.rt !== 'string' ||
    !ID_RE.test(p.agent)
  )
    throw new SessionError('malformed run token');
  return { subject: p.sub, agentId: p.agent, runtimeId: p.rt };
}
