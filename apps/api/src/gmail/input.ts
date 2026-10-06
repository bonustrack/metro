import { parseId } from '@metro-labs/core/ids';
import { isRecord } from '@metro-labs/core/is-record';
import { parseMailbox } from '@metro-labs/core/stations/oauth';
import { ApiError } from '@metro-labs/http/api-error';
import { parseServerHost } from '../server-types.js';

export class GmailError extends ApiError {}

export const staleState = (): GmailError => new GmailError('This Gmail sign-in is stale or does not match this request. Start again.', 400);
export const invalidGrant = (): GmailError => new GmailError('This Gmail refresh grant is invalid or expired. Connect Gmail again.', 401);

export function inputObject(body: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!isRecord(body) || Object.keys(body).some((key) => !fields.includes(key))) throw new GmailError('Invalid Gmail request.', 400);
  return body;
}

export function inputText(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || /[\s\p{Cc}]/u.test(value))
    throw new GmailError('Invalid Gmail request.', 400);
  return value;
}

export function inputHost(value: unknown): string {
  const host = inputText(value, 253);
  if (parseServerHost(host) !== host) throw new GmailError('Use the saved server address for Gmail sign-in.', 400);
  return host;
}

export function inputAgent(value: unknown): string {
  const agentId = parseId(value);
  if (agentId === null) throw new GmailError('Invalid Gmail agent.', 400);
  return agentId;
}

export function inputMailbox(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.length > 254) throw new GmailError('Invalid Gmail mailbox.', 400);
  try {
    return parseMailbox(value);
  } catch {
    throw new GmailError('Invalid Gmail mailbox.', 400);
  }
}

export function inputChallenge(value: unknown): string {
  const challenge = inputText(value, 43);
  if (!/^[A-Za-z0-9_-]{43}$/.test(challenge) || Buffer.from(challenge, 'base64url').toString('base64url') !== challenge)
    throw new GmailError('Invalid Gmail sign-in challenge.', 400);
  return challenge;
}

export function inputVerifier(value: unknown): string {
  const verifier = inputText(value, 128);
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) throw staleState();
  return verifier;
}
