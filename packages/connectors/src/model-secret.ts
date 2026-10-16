import { isClaudeToken } from '@metro-labs/core/claude-token';
import { isRecord } from '@metro-labs/core/is-record';
import { parsedJson } from './model.js';
import { openSecret, sealSecret } from './secrets.js';

export const MODEL_PROVIDERS = ['anthropic', 'bedrock', 'openrouter', 'codex', 'routeway'] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];
export const KEY_PROVIDERS: readonly ModelProvider[] = ['anthropic', 'bedrock', 'openrouter', 'routeway'];

export type CodexMethod = 'chatgpt' | 'code';

export interface CodexSecret {
  kind: 'codex';
  method: CodexMethod;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  clientId?: string;
  subject?: string;
  accountId?: string;
}

export type ModelSecret = { kind: 'key'; apiKey: string } | { kind: 'claude'; token: string } | CodexSecret;

export interface ModelDetail {
  email?: string;
  plan?: string;
  method?: CodexMethod;
  accountId?: string;
  signedInAt?: string;
  refreshedAt?: string;
  signedOut?: boolean;
  subscription?: boolean;
}

const TOKEN_RE = /^[\x21-\x7e]{1,16384}$/;
const DETAIL_TEXT = ['email', 'plan', 'accountId', 'signedInAt', 'refreshedAt'] as const;

export const isModelProvider = (value: unknown): value is ModelProvider => typeof value === 'string' && (MODEL_PROVIDERS as readonly string[]).includes(value);

export const isCodexMethod = (value: unknown): value is CodexMethod => value === 'chatgpt' || value === 'code';

interface Sealed {
  owner: string;
  id: string;
}

export const sealModelSecret = (key: Buffer, row: Sealed, secret: ModelSecret): string => sealSecret(key, row.owner, row.id, secret, 'model');

const token = (value: unknown): string | null => (typeof value === 'string' && TOKEN_RE.test(value) ? value : null);

const optional = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

const expiryOf = (value: unknown): number | null => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null);

function codexExtra(value: Record<string, unknown>, method: CodexMethod): Pick<CodexSecret, 'clientId' | 'subject' | 'accountId'> | null {
  const clientId = optional(value.clientId);
  const subject = optional(value.subject);
  const accountId = optional(value.accountId);
  if ((method === 'chatgpt' && clientId === undefined) || (method === 'code' && accountId === undefined)) return null;
  return { ...(clientId === undefined ? {} : { clientId }), ...(subject === undefined ? {} : { subject }), ...(accountId === undefined ? {} : { accountId }) };
}

function codexOf(value: Record<string, unknown>): CodexSecret | null {
  const accessToken = token(value.accessToken);
  const refreshToken = token(value.refreshToken);
  const expiresAt = expiryOf(value.expiresAt);
  if (!isCodexMethod(value.method) || accessToken === null || refreshToken === null || expiresAt === null) return null;
  const extra = codexExtra(value, value.method);
  return extra === null ? null : { kind: 'codex', method: value.method, accessToken, refreshToken, expiresAt, ...extra };
}

export function modelSecretOf(value: unknown): ModelSecret | null {
  if (!isRecord(value)) return null;
  if (value.kind === 'key') {
    const apiKey = token(value.apiKey);
    return apiKey === null ? null : { kind: 'key', apiKey };
  }
  if (value.kind === 'claude') return typeof value.token === 'string' && isClaudeToken(value.token) ? { kind: 'claude', token: value.token } : null;
  return value.kind === 'codex' ? codexOf(value) : null;
}

export function openModelSecret(key: Buffer, row: Sealed & { secret: string | null }): ModelSecret | null {
  if (row.secret === null) return null;
  return modelSecretOf(openSecret(key, row.owner, row.id, row.secret, 'model'));
}

export function modelDetailOf(text: string | null): ModelDetail {
  const value = parsedJson(text);
  if (!isRecord(value)) return {};
  const out: ModelDetail = {};
  for (const field of DETAIL_TEXT) {
    const held = value[field];
    if (typeof held === 'string' && held !== '') out[field] = held;
  }
  if (isCodexMethod(value.method)) out.method = value.method;
  if (value.signedOut === true) out.signedOut = true;
  if (value.subscription === true) out.subscription = true;
  return out;
}

export const modelDetailText = (detail: ModelDetail): string | null => (Object.keys(detail).length === 0 ? null : JSON.stringify(detail));
