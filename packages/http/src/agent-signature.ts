import { createHash, createPublicKey, randomBytes, sign, verify, type KeyObject } from 'node:crypto';
import { strongEd25519 } from './ed25519.js';

const AGENT_SCHEME = 'MetroAgent';
export const AGENT_CLOCK_SKEW_MS = 5 * 60_000;

const VERSION = 'metro-agent-request/v1';
const KEY_ID_RE = /^[A-Za-z0-9_-]{43}$/;
const NONCE_RE = /^[A-Za-z0-9_-]{22}$/;
const SIGNATURE_RE = /^[A-Za-z0-9_-]{86}$/;
const TIME_RE = /^[0-9]{1,15}$/;
const RAW_KEY_RE = /^[A-Za-z0-9_-]{43}$/;

export interface AgentRequest {
  method: string;
  host: string;
  path: string;
  body: Uint8Array;
}

export interface AgentProof {
  keyId: string;
  time: number;
  nonce: string;
  signature: string;
}

const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('base64url');

export const agentKeyId = (signingKey: string): string => digest(Buffer.from(signingKey, 'base64url'));

function publicKeyOf(raw: string): KeyObject | null {
  if (!RAW_KEY_RE.test(raw) || Buffer.from(raw, 'base64url').toString('base64url') !== raw) return null;
  try {
    const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw }, format: 'jwk' });
    return key.asymmetricKeyType === 'ed25519' ? key : null;
  } catch {
    return null;
  }
}

export function signingKeyOf(raw: string): KeyObject | null {
  const key = publicKeyOf(raw);
  return key !== null && strongEd25519(Buffer.from(raw, 'base64url')) ? key : null;
}

export function rawPublicKey(key: KeyObject): string {
  const { x } = key.export({ format: 'jwk' });
  if (typeof x !== 'string') throw new Error('not an OKP public key');
  return x;
}

function signingInput(request: AgentRequest, proof: Omit<AgentProof, 'signature'>): Buffer {
  return Buffer.from([
    VERSION,
    request.method.toUpperCase(),
    request.host.toLowerCase(),
    request.path,
    proof.keyId,
    String(proof.time),
    proof.nonce,
    digest(request.body),
  ].join('\n'));
}

export function signAgentRequest(request: AgentRequest, privateKey: KeyObject, keyId: string, time: number): string {
  const nonce = randomBytes(16).toString('base64url');
  const signature = sign(null, signingInput(request, { keyId, time, nonce }), privateKey).toString('base64url');
  return `${AGENT_SCHEME} ${keyId}.${String(time)}.${nonce}.${signature}`;
}

const PARTS = [KEY_ID_RE, TIME_RE, NONCE_RE, SIGNATURE_RE];

function partsOf(header: string | undefined): string[] | null {
  if (header === undefined || header.length > 256) return null;
  const [scheme, value, extra] = header.trim().split(' ');
  if (scheme !== AGENT_SCHEME || value === undefined || extra !== undefined) return null;
  const parts = value.split('.');
  return parts.length === PARTS.length && parts.every((part, i) => PARTS[i]?.test(part) === true) ? parts : null;
}

export function readAgentProof(header: string | undefined): AgentProof | null {
  const parts = partsOf(header);
  if (parts === null) return null;
  const [keyId = '', time = '', nonce = '', signature = ''] = parts;
  return { keyId, time: Number(time), nonce, signature };
}

export const withinSkew = (time: number, now: number): boolean => Math.abs(now - time) <= AGENT_CLOCK_SKEW_MS;

export function agentSignatureValid(request: AgentRequest, proof: AgentProof, signingKey: string): boolean {
  const key = signingKeyOf(signingKey);
  if (key === null || agentKeyId(signingKey) !== proof.keyId) return false;
  return verify(null, signingInput(request, proof), key, Buffer.from(proof.signature, 'base64url'));
}
