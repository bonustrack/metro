import { ID_RE } from '@metro-labs/core/ids';
import { isRecord } from '@metro-labs/core/is-record';
import { ApiError } from '@metro-labs/http/api-error';
import type { ImportRow } from '@metro-labs/connectors/db/model-delivery';
import { nonEmpty } from '@metro-labs/connectors/codex-tokens';
import { distinctFallbacks, FALLBACKS_MAX, isLocalRef, LOCAL_SESSION, localLogin, MODEL_ID_MAX, type ModelRoute, type RouteTarget } from '@metro-labs/connectors/model-route';
import { isModelProvider, KEY_PROVIDERS, modelDetailText, modelSecretOf, sealModelSecret, type ModelDetail, type ModelProvider, type ModelSecret } from '@metro-labs/connectors/model-secret';
import { NEW_CLIENT } from './codex-login.js';
import { LABEL_MAX, LABELS, REGION_RE } from './input.js';

const CONNECTIONS_MAX = 20;
const KEY_MAX = 4096;

interface Sent {
  id: string;
  model: string;
}

interface Wanted {
  ref: string;
  model: string;
}

export interface ImportPlan {
  rows: ImportRow[];
  local: Map<string, string>;
  route: (ids: Map<string, string>) => ModelRoute | null;
}

const bad = (message: string): ApiError => new ApiError(message, 400);

const text = (value: unknown, max: number): string => (typeof value === 'string' ? value.trim().slice(0, max) : '');

const expiryOf = (value: unknown): number => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0);

function codexMethod(raw: Record<string, unknown>): 'chatgpt' | 'code' {
  if (raw.method === 'chatgpt' || raw.method === 'code') return raw.method;
  return nonEmpty(raw.accountId) === null ? 'chatgpt' : 'code';
}

function codexSecret(raw: Record<string, unknown>): ModelSecret | null {
  const method = codexMethod(raw);
  const clientId = nonEmpty(raw.clientId);
  if (method === 'chatgpt' && clientId === NEW_CLIENT) return null;
  return modelSecretOf({
    kind: 'codex', method, accessToken: raw.accessToken, refreshToken: raw.refreshToken, expiresAt: expiryOf(raw.expiresAt),
    clientId: clientId ?? undefined, subject: nonEmpty(raw.subject) ?? undefined, accountId: nonEmpty(raw.accountId) ?? undefined,
  });
}

function codexDetail(raw: Record<string, unknown>, secret: ModelSecret | null): string | null {
  if (secret?.kind !== 'codex') return null;
  const detail: ModelDetail = { method: secret.method };
  const email = nonEmpty(raw.email);
  const plan = nonEmpty(raw.plan);
  const signedInAt = nonEmpty(raw.savedAt);
  if (email !== null) detail.email = email;
  if (plan !== null) detail.plan = plan;
  if (secret.accountId !== undefined) detail.accountId = secret.accountId;
  if (signedInAt !== null) detail.signedInAt = signedInAt;
  return modelDetailText(detail);
}

function secretOf(raw: Record<string, unknown>, provider: ModelProvider): ModelSecret | null {
  if (provider === 'codex') return isRecord(raw.codex) ? codexSecret(raw.codex) : null;
  return KEY_PROVIDERS.includes(provider) ? modelSecretOf({ kind: 'key', apiKey: text(raw.apiKey, KEY_MAX) }) : null;
}

function rowOf(key: Buffer, raw: Record<string, unknown>, id: string, provider: ModelProvider): ImportRow {
  const secret = secretOf(raw, provider);
  const region = text(raw.region, 64);
  return {
    importId: id,
    provider,
    label: text(raw.label, LABEL_MAX) || LABELS[provider],
    model: text(raw.model, MODEL_ID_MAX),
    region: REGION_RE.test(region) ? region : '',
    zdr: raw.zdr === true,
    secret: (row) => (secret === null ? null : sealModelSecret(key, row, secret)),
    detail: provider === 'codex' && isRecord(raw.codex) ? codexDetail(raw.codex, secret) : null,
  };
}

function localRef(raw: Record<string, unknown>, provider: ModelProvider): string | null {
  if (isRecord(raw.claude) && typeof raw.claude.id === 'string' && ID_RE.test(raw.claude.id)) return localLogin(raw.claude.id);
  return provider === 'anthropic' && text(raw.apiKey, KEY_MAX) === '' ? LOCAL_SESSION : null;
}

function entryOf(raw: unknown): { raw: Record<string, unknown>; id: string; provider: ModelProvider } | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || !ID_RE.test(raw.id)) throw bad('each connection needs its 11-character id');
  if (raw.provider === 'gemini') return null;
  if (!isModelProvider(raw.provider)) throw bad('each connection needs a provider: anthropic, bedrock, openrouter or codex');
  return { raw, id: raw.id, provider: raw.provider };
}

function wantedOf(raw: unknown, sent: Sent[]): Wanted | null {
  if (typeof raw === 'string') return raw === '' ? null : { ref: raw, model: sent.find((c) => c.id === raw)?.model ?? '' };
  if (!isRecord(raw) || typeof raw.connection !== 'string') return null;
  return { ref: raw.connection, model: text(raw.model, MODEL_ID_MAX) };
}

function mapped(wanted: Wanted | null, ids: Map<string, string>, local: Map<string, string>, needsModel: boolean): RouteTarget | null {
  if (wanted === null) return null;
  const connection = isLocalRef(wanted.ref) ? wanted.ref : (ids.get(wanted.ref) ?? local.get(wanted.ref) ?? null);
  if (connection === null || (needsModel && wanted.model === '' && !isLocalRef(connection))) return null;
  return { connection, model: wanted.model };
}

function routeBuilder(body: Record<string, unknown>, sent: Sent[], local: Map<string, string>): (ids: Map<string, string>) => ModelRoute | null {
  const rawFallbacks: unknown[] = Array.isArray(body.fallbacks) ? body.fallbacks.slice(0, FALLBACKS_MAX * 4) : [];
  return (ids) => {
    const primary = mapped(wantedOf(body.route, sent), ids, local, false);
    const fallbacks = distinctFallbacks(rawFallbacks.flatMap((raw) => mapped(wantedOf(raw, sent), ids, local, true) ?? []));
    return primary === null && fallbacks.length === 0 ? null : { primary, fallbacks };
  };
}

export function importPlan(key: Buffer, body: unknown): ImportPlan {
  if (!isRecord(body) || !Array.isArray(body.connections)) throw bad('Send the connections of model.json, its route and its fallbacks.');
  if (body.connections.length > CONNECTIONS_MAX) throw bad(`A box keeps at most ${String(CONNECTIONS_MAX)} connections.`);
  const rows: ImportRow[] = [];
  const local = new Map<string, string>();
  const sent: Sent[] = [];
  for (const raw of body.connections) {
    const entry = entryOf(raw);
    if (entry === null || sent.some((held) => held.id === entry.id)) continue;
    sent.push({ id: entry.id, model: text(entry.raw.model, MODEL_ID_MAX) });
    const ref = localRef(entry.raw, entry.provider);
    if (ref === null) rows.push(rowOf(key, entry.raw, entry.id, entry.provider));
    else local.set(entry.id, ref);
  }
  return { rows, local, route: routeBuilder(body, sent, local) };
}
