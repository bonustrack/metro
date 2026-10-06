import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { isRecord } from '@metro-labs/core/is-record';
import { isOrganizationId } from '@metro-labs/http/workos-token';
import type { GmailConfig } from './config.js';
import { inputAgent, inputHost, inputMailbox, inputText, invalidGrant } from './input.js';

const GRANT_TTL_MS = 90 * 24 * 60 * 60_000;
const PREFIX = 'gmail1';

export interface GmailIdentity {
  organization: string;
  userId: string;
  serverId: string;
  host: string;
  agentId: string;
  email: string;
  sendEnabled: boolean;
}

export interface GmailGrant extends GmailIdentity {
  clientId: string;
  refreshDigest: string;
  issuedAt: number;
  expiresAt: number;
}

const digest = (token: string): Buffer => createHash('sha256').update(token).digest();
const signature = (payload: string, config: GmailConfig): Buffer => createHmac('sha256', config.grantKey).update(`${PREFIX}.${payload}`).digest();

export function issueGmailGrant(identity: GmailIdentity, token: string, config: GmailConfig, now: number): string {
  const grant: GmailGrant = {
    organization: identity.organization,
    userId: identity.userId,
    serverId: identity.serverId,
    host: identity.host,
    agentId: identity.agentId,
    email: identity.email,
    sendEnabled: identity.sendEnabled,
    clientId: config.clientId,
    refreshDigest: digest(token).toString('base64url'),
    issuedAt: now,
    expiresAt: now + GRANT_TTL_MS,
  };
  const payload = Buffer.from(JSON.stringify(grant)).toString('base64url');
  return `${PREFIX}.${payload}.${signature(payload, config).toString('base64url')}`;
}

function decodePart(text: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) throw invalidGrant();
  const decoded = Buffer.from(text, 'base64url');
  if (decoded.toString('base64url') !== text) throw invalidGrant();
  return decoded;
}

function grantIdentity(body: Record<string, unknown>): GmailIdentity {
  const organization = inputText(body.organization, 128);
  const email = inputMailbox(body.email);
  if (!isOrganizationId(organization) || email === null || email !== body.email || typeof body.sendEnabled !== 'boolean') throw invalidGrant();
  return {
    organization,
    userId: inputText(body.userId, 128),
    serverId: inputAgent(body.serverId),
    host: inputHost(body.host),
    agentId: inputAgent(body.agentId),
    email,
    sendEnabled: body.sendEnabled,
  };
}

function grantLifetime(body: Record<string, unknown>, now: number, purpose: 'refresh' | 'revoke'): { issuedAt: number; expiresAt: number } {
  const { issuedAt, expiresAt } = body;
  if (typeof issuedAt !== 'number' || typeof expiresAt !== 'number' || !Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt)) throw invalidGrant();
  const expiresAfter = purpose === 'revoke' ? issuedAt : now;
  if (issuedAt < 0 || issuedAt > now || expiresAt <= expiresAfter || expiresAt - issuedAt > GRANT_TTL_MS) throw invalidGrant();
  return { issuedAt, expiresAt };
}

function parseGrant(payload: string, token: string, host: string, config: GmailConfig, now: number, purpose: 'refresh' | 'revoke'): GmailGrant {
  const body: unknown = JSON.parse(decodePart(payload).toString('utf8'));
  if (!isRecord(body) || body.clientId !== config.clientId || body.host !== host) throw invalidGrant();
  const refreshDigest = inputText(body.refreshDigest, 43);
  const decoded = decodePart(refreshDigest);
  if (decoded.length !== 32 || !timingSafeEqual(decoded, digest(token))) throw invalidGrant();
  return { ...grantIdentity(body), ...grantLifetime(body, now, purpose), clientId: config.clientId, refreshDigest };
}

export function readGmailGrant(grant: string, token: string, host: string, config: GmailConfig, now: number, purpose: 'refresh' | 'revoke' = 'refresh'): GmailGrant {
  try {
    if (grant.length > 8192) throw invalidGrant();
    const [prefix, payload, signed, extra] = grant.split('.');
    if (prefix !== PREFIX || payload === undefined || signed === undefined || extra !== undefined) throw invalidGrant();
    const sig = decodePart(signed);
    if (sig.length !== 32 || !timingSafeEqual(sig, signature(payload, config))) throw invalidGrant();
    return parseGrant(payload, token, host, config, now, purpose);
  } catch {
    throw invalidGrant();
  }
}
