import { ID_RE, newId, parseId } from '@metro-labs/core/ids';
import { isRecord } from '@metro-labs/core/is-record';
import { ApiError } from '@metro-labs/http/api-error';
import type { ModelConnectionRow } from '@metro-labs/connectors/db/models';
import { distinctFallbacks, FALLBACKS_MAX, isLocalRef, MODEL_ID_MAX, type ModelRoute, type RouteTarget } from '@metro-labs/connectors/model-route';
import type { ModelProvider } from '@metro-labs/connectors/model-secret';
import type { Caller } from './deps.js';

export const LABEL_MAX = 60;
export const REGION_RE = /^[a-z]{2}(?:-[a-z]+)+-\d{1,2}$/;
const API_KEY_RE = /^[\x21-\x7e]{1,4096}$/;

export const LABELS: Record<ModelProvider, string> = {
  anthropic: 'Anthropic',
  bedrock: 'Amazon Bedrock',
  openrouter: 'OpenRouter',
  codex: 'Codex (ChatGPT)',
};

const bad = (message: string): ApiError => new ApiError(message, 400);

export function labelFor(taken: ModelConnectionRow[], provider: ModelProvider, given: string): string {
  if (given !== '') return given;
  const count = taken.filter((row) => row.provider === provider).length;
  return count === 0 ? LABELS[provider] : `${LABELS[provider]} ${String(count + 1)}`;
}

export function textField(body: Record<string, unknown>, key: string, what: string, max: number): string | undefined {
  if (!Object.hasOwn(body, key)) return undefined;
  const value = body[key];
  if (typeof value !== 'string') throw bad(`${what} must be a string`);
  if (value.length > max) throw bad(`${what} is too long`);
  return value.trim();
}

export function regionOf(value: unknown): string {
  if (value === undefined || value === '') return '';
  if (typeof value !== 'string' || !REGION_RE.test(value.trim())) throw bad('region must be an AWS region such as us-east-1');
  return value.trim();
}

export function apiKeyOf(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!API_KEY_RE.test(text)) throw bad('Give the API key: printable characters, 4,096 at most.');
  return text;
}

export function flagOf(value: unknown, what: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw bad(`${what} must be true or false`);
  return value;
}

export function connectionArg(body: unknown): string | null {
  const raw = isRecord(body) ? body.connection : undefined;
  if (raw === undefined || raw === null || raw === '') return null;
  const id = parseId(raw);
  if (id === null) throw bad('connection must be a model connection id');
  return id;
}

export function newModelRow(caller: Pick<Caller, 'owner'> & { userId: string }, provider: ModelProvider, label: string, at: string): ModelConnectionRow {
  return {
    id: newId(), owner: caller.owner, provider, label, model: '', region: '', zdr: false, secret: null, detail: null, revision: 1,
    importAgent: null, importId: null, createdBy: `user:${caller.userId}`, createdAt: at, updatedAt: at,
  };
}

export const creator = (caller: Caller): { owner: string; userId: string } => ({ owner: caller.owner, userId: caller.session.userId });

function modelInput(raw: Record<string, unknown>, what: string): string {
  if (raw.model === undefined) return '';
  if (typeof raw.model !== 'string') throw bad(`${what}: the model must be a string`);
  const model = raw.model.trim();
  if (model.length > MODEL_ID_MAX) throw bad(`${what}: the model id is too long`);
  return model;
}

function targetInput(raw: unknown, agentRoute: boolean, what: string): RouteTarget {
  if (!isRecord(raw) || typeof raw.connection !== 'string') throw bad(`${what} must be an object with a connection and a model`);
  const connection = raw.connection.trim();
  const model = modelInput(raw, what);
  const local = isLocalRef(connection);
  if (local && !agentRoute) throw bad('Only an agent route may use the box’s own Claude login.');
  if (!local && !ID_RE.test(connection)) throw bad(`${what} names no model connection`);
  if (model === '' && !local) throw bad(`${what} needs a model`);
  return { connection, model };
}

export function routeInput(body: Record<string, unknown>, agentRoute: boolean): ModelRoute {
  const primary = body.primary === null || body.primary === undefined ? null : targetInput(body.primary, agentRoute, 'primary');
  const raw = body.fallbacks ?? [];
  if (!Array.isArray(raw)) throw bad('fallbacks must be a list');
  if (raw.length > FALLBACKS_MAX) throw bad(`A route keeps at most ${String(FALLBACKS_MAX)} fallbacks.`);
  return { primary, fallbacks: distinctFallbacks(raw.map((entry: unknown) => targetInput(entry, agentRoute, 'each fallback'))) };
}
