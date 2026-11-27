import { createHash, createSign, randomBytes, verify, type KeyObject } from 'node:crypto';
import { chatFilesOf, type ChatFile } from '@metro-labs/core/chat';
import { isRecord } from '@metro-labs/core/is-record';
import { isOrganizationId, METRO_ISSUER, type KeySource } from './user-token.js';

const CHAT_TICKET_TYP = 'metro-chat';
const AUDIENCE = 'metro-chat';
const SEND_TICKET_S = 120;
const FILES_TICKET_S = 15 * 60;
const VIEW_TICKET_S = 2 * 60;
const SKEW_S = 30;
const ID_RE = /^[A-Za-z0-9_-]{11}$/;
const USER_RE = /^[A-Za-z0-9_]{1,64}$/;
const NAME_MAX = 120;
const EMAIL_MAX = 254;
const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+$/;

type ChatAct = 'send' | 'view';

export interface ChatTicketClaims {
  organization: string;
  agent: string;
  chat: string;
  user: string;
  name: string;
  email: string | null;
  act: ChatAct;
  message: string | null;
  digest: string | null;
  files: ChatFile[];
  group: boolean;
}

export interface ChatTicket extends ChatTicketClaims {
  id: string;
  expiresAt: number;
}

export interface ChatSigner {
  kid: string;
  privateKey: KeyObject;
}

export const textDigest = (text: string): string => createHash('sha256').update(text, 'utf8').digest('base64url');

const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

const ticketLife = (act: ChatAct, files: boolean): number => (act === 'view' ? VIEW_TICKET_S : files ? FILES_TICKET_S : SEND_TICKET_S);

export function signChatTicket(signer: ChatSigner, claims: ChatTicketClaims, now = Date.now()): string {
  const iat = Math.floor(now / 1000);
  const ttl = ticketLife(claims.act, claims.files.length > 0);
  const head = b64({ alg: 'RS256', typ: CHAT_TICKET_TYP, kid: signer.kid });
  const body = b64({
    iss: METRO_ISSUER,
    aud: AUDIENCE,
    jti: randomBytes(12).toString('base64url'),
    org: claims.organization,
    agent: claims.agent,
    chat: claims.chat,
    sub: claims.user,
    name: claims.name.slice(0, NAME_MAX),
    ...(claims.email === null ? {} : { email: claims.email }),
    act: claims.act,
    ...(claims.message === null ? {} : { msg: claims.message }),
    ...(claims.digest === null ? {} : { sha: claims.digest }),
    ...(claims.files.length === 0 ? {} : { files: claims.files }),
    group: claims.group,
    iat,
    exp: iat + ttl,
  });
  const signature = createSign('RSA-SHA256').update(`${head}.${body}`).sign(signer.privateKey).toString('base64url');
  return `${head}.${body}.${signature}`;
}

function jsonPart(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const text = (value: unknown, re: RegExp): string | null => (typeof value === 'string' && re.test(value) ? value : null);
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isInteger(value) ? value : null);

function fresh(claims: Record<string, unknown>, act: ChatAct, now: number): number | null {
  const files = Array.isArray(claims.files) && claims.files.length > 0;
  const iat = num(claims.iat);
  const exp = num(claims.exp);
  if (iat === null || exp === null) return null;
  const ttl = ticketLife(act, files);
  if (exp - iat > ttl || iat * 1000 > now + SKEW_S * 1000 || exp * 1000 < now - SKEW_S * 1000) return null;
  return exp * 1000;
}

const emailOf = (value: unknown): string | null => (typeof value === 'string' && value.length <= EMAIL_MAX && EMAIL_RE.test(value) ? value : null);

const actOf = (value: unknown): ChatAct | null => (value === 'send' || value === 'view' ? value : null);

function messageFacts(claims: Record<string, unknown>, act: ChatAct): { message: string | null; digest: string | null; files: ChatFile[] } | null {
  if (act === 'view') return { message: null, digest: null, files: [] };
  const message = text(claims.msg, ID_RE);
  const digest = text(claims.sha, /^[A-Za-z0-9_-]{43}$/);
  const files = chatFilesOf(claims.files);
  return message === null || digest === null || files === null ? null : { message, digest, files };
}

function ids(claims: Record<string, unknown>): Pick<ChatTicket, 'organization' | 'agent' | 'chat' | 'user' | 'id'> | null {
  const organization = typeof claims.org === 'string' && isOrganizationId(claims.org) ? claims.org : null;
  const agent = text(claims.agent, ID_RE);
  const chat = text(claims.chat, ID_RE);
  const user = text(claims.sub, USER_RE);
  const id = text(claims.jti, /^[A-Za-z0-9_-]{16}$/);
  if (organization === null || agent === null || chat === null || user === null || id === null) return null;
  return { organization, agent, chat, user, id };
}

function chatTicketOf(claims: Record<string, unknown>, now: number): ChatTicket | null {
  if (claims.iss !== METRO_ISSUER || claims.aud !== AUDIENCE) return null;
  const act = actOf(claims.act);
  const who = ids(claims);
  if (act === null || who === null) return null;
  const expiresAt = fresh(claims, act, now);
  const facts = messageFacts(claims, act);
  if (expiresAt === null || facts === null) return null;
  const name = typeof claims.name === 'string' ? claims.name.slice(0, NAME_MAX) : '';
  return { ...who, ...facts, act, name, email: emailOf(claims.email), group: claims.group === true, expiresAt };
}

interface TicketParts {
  signed: string;
  kid: string;
  claims: Record<string, unknown>;
  signature: Buffer;
}

const ticketKid = (header: Record<string, unknown> | null): string | null =>
  header?.alg === 'RS256' && header.typ === CHAT_TICKET_TYP && typeof header.kid === 'string' ? header.kid : null;

function ticketParts(token: unknown): TicketParts | null {
  if (typeof token !== 'string' || token.length > 8192) return null;
  const [head, body, sig] = token.split('.');
  if (head === undefined || body === undefined || sig === undefined) return null;
  const kid = ticketKid(jsonPart(head));
  const claims = jsonPart(body);
  if (kid === null || claims === null) return null;
  return { signed: `${head}.${body}`, kid, claims, signature: Buffer.from(sig, 'base64url') };
}

export async function verifyChatTicket(token: unknown, keys: KeySource, now = Date.now()): Promise<ChatTicket | null> {
  const parts = ticketParts(token);
  if (parts === null) return null;
  const key = await keys.keyFor(parts.kid, now).catch(() => null);
  if (key === null || !verify('sha256', Buffer.from(parts.signed), key, parts.signature)) return null;
  return chatTicketOf(parts.claims, now);
}
